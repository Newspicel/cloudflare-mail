import type { DB } from "@cfmail/db";
import { mailboxSpamUsage } from "@cfmail/db/schema";
import { sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { dohQuery } from "./dns.ts";
import type { ParsedEmail } from "./mime.ts";

export type SpamLevel = "off" | "auth" | "standard" | "ai";
export type SpamVerdict = "clean" | "suspicious" | "spam";

export interface AuthResult {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface SpamEvaluation {
  verdict: SpamVerdict;
  score: number;
  reasons: string[];
  auth: AuthResult;
  // Whether a newly-created thread should be filed under Spam.
  folderSpam: boolean;
}

export interface EvaluateInput {
  mailboxId: string;
  level: Exclude<SpamLevel, "off">;
  aiTokenCap: number | null;
  parsed: ParsedEmail;
  fromEnvelope: string;
}

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// Score thresholds. A reliable auth failure alone (+5) reaches SPAM; softer
// content/IP signals can only ever push a message into the gray zone, so they
// are never the sole reason to file as spam.
const SUSPICIOUS_AT = 2;
const SPAM_AT = 5;

const SPAM_KEYWORDS = [
  "viagra",
  "lottery",
  "you have won",
  "you won",
  "free money",
  "click here now",
  "act now",
  "limited time offer",
  "congratulations",
  "claim your prize",
  "wire transfer",
  "bitcoin",
  "crypto investment",
  "investment opportunity",
  "nigerian prince",
  "inheritance",
  "verify your account",
  "account suspended",
  "urgent action required",
  "gift card",
  "risk-free",
  "double your",
];

export async function evaluateSpam(
  env: Env,
  db: DB,
  input: EvaluateInput,
): Promise<SpamEvaluation> {
  const { parsed, level } = input;
  const auth = parseAuthResults(parsed);

  // Fully authenticated mail (DMARC pass implies an aligned, passing SPF or
  // DKIM) is trusted — skip every further check to avoid false positives and
  // cost.
  if (auth.dmarc === "pass") {
    return { verdict: "clean", score: 0, reasons: [], auth, folderSpam: false };
  }

  const reasons: string[] = [];
  let score = 0;

  // ─── Authentication signal (all levels) ──────────────────────────────────
  if (auth.dmarc === "fail") {
    score += 5;
    reasons.push("DMARC authentication failed — this sender is likely forged.");
  } else if (auth.spf === "fail" && auth.dkim === "fail") {
    score += 5;
    reasons.push("Both SPF and DKIM authentication failed — this sender may be forged.");
  } else if (!auth.spf && !auth.dkim && !auth.dmarc) {
    score += 2;
    reasons.push("No sender authentication results were present.");
  } else if (auth.spf !== "pass" && auth.dkim !== "pass") {
    score += 2;
    reasons.push("This message is not authenticated (SPF and DKIM did not pass).");
  } else if (!auth.dmarc || auth.dmarc === "none") {
    score += 2;
    reasons.push("The sender domain has no DMARC policy.");
  }

  // ─── Content heuristics + IP blocklist (standard / ai) ────────────────────
  if (level !== "auth") {
    const heur = scoreHeuristics(parsed);
    score += heur.score;
    reasons.push(...heur.reasons);

    const ip = extractOriginIp(parsed);
    if (ip) {
      const listed = await checkDnsbl(ip);
      if (listed) {
        score += 2;
        reasons.push(`The sending IP (${ip}) is on a spam blocklist.`);
      }
    }
  }

  let verdict = scoreToVerdict(score);

  // ─── AI refinement, gray zone only (ai level) ─────────────────────────────
  if (level === "ai" && score >= SUSPICIOUS_AT && score < SPAM_AT) {
    const ai = await classifyWithAI(env, db, input);
    if (ai) {
      verdict = ai.verdict;
      if (ai.reason) reasons.push(`AI: ${ai.reason}`);
    }
  }

  return { verdict, score, reasons, auth, folderSpam: verdict === "spam" };
}

function scoreToVerdict(score: number): SpamVerdict {
  if (score >= SPAM_AT) return "spam";
  if (score >= SUSPICIOUS_AT) return "suspicious";
  return "clean";
}

// ─── Authentication-Results parsing ─────────────────────────────────────────

const AUTH_METHODS = ["spf", "dkim", "dmarc"] as const;

export function parseAuthResults(parsed: ParsedEmail): AuthResult {
  const headers = parsed.headers ?? [];
  const lines = headers
    .filter((h) => h.key === "authentication-results")
    .map((h) => h.value.toLowerCase());
  const combined = lines.join("; ");

  const out: AuthResult = {};
  for (const m of AUTH_METHODS) {
    // e.g. "spf=pass", "dkim=fail (...)", "dmarc=none"
    const match = combined.match(new RegExp(`\\b${m}=(\\w+)`));
    if (match) out[m] = match[1];
  }

  // Fall back to a standalone Received-SPF header when SPF is absent.
  if (!out.spf) {
    const rspf = headers.find((h) => h.key === "received-spf")?.value.toLowerCase();
    const m = rspf?.match(/^\s*(\w+)/);
    if (m) out.spf = m[1];
  }
  return out;
}

// ─── Content heuristics ─────────────────────────────────────────────────────

function scoreHeuristics(parsed: ParsedEmail): { score: number; reasons: string[] } {
  const subject = parsed.subject ?? "";
  const body = parsed.text ?? stripHtml(parsed.html ?? "");
  const haystack = `${subject}\n${body}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const hits = SPAM_KEYWORDS.filter((kw) => haystack.includes(kw));
  if (hits.length) {
    score += Math.min(hits.length, 3);
    reasons.push(`Contains spam-associated phrasing (${hits.slice(0, 3).join(", ")}).`);
  }

  if (isMostlyCaps(subject)) {
    score += 1;
    reasons.push("Subject is written mostly in capital letters.");
  }

  if (/!{3,}|\${3,}|\$\$\$/.test(haystack)) {
    score += 1;
    reasons.push("Uses excessive punctuation typical of spam.");
  }

  const from = (parsed.from?.address ?? "").toLowerCase();
  if (from.includes("noreply") && /\b(urgent|immediately|act now|expire)\b/.test(haystack)) {
    score += 2;
    reasons.push("No-reply sender combined with urgent language.");
  }

  return { score, reasons };
}

function isMostlyCaps(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, "");
  if (letters.length < 8) return false;
  const upper = text.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.7;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

// ─── DNSBL (Spamhaus) — best-effort soft signal ─────────────────────────────

function extractOriginIp(parsed: ParsedEmail): string | null {
  // Walk Received headers bottom-up (postal-mime preserves order top-down, so
  // the originating relay is last) and take the first public IPv4 we find.
  const received = (parsed.headers ?? [])
    .filter((h) => h.key === "received")
    .map((h) => h.value)
    .toReversed();
  for (const line of received) {
    const m = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    if (m && isPublicIp(m[1]!)) return m[1]!;
  }
  return null;
}

function isPublicIp(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10 || p[0] === 127) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  return true;
}

async function checkDnsbl(ip: string): Promise<boolean> {
  try {
    const reversed = ip.split(".").toReversed().join(".");
    // A listed IP resolves to a 127.0.0.0/8 address.
    const answers = await dohQuery(`${reversed}.zen.spamhaus.org`, "A");
    return answers.some((a) => a.startsWith("127."));
  } catch {
    return false;
  }
}

// ─── Workers AI classification (gray zone) ──────────────────────────────────

interface AiVerdict {
  verdict: SpamVerdict;
  reason: string;
}

async function classifyWithAI(env: Env, db: DB, input: EvaluateInput): Promise<AiVerdict | null> {
  const period = currentPeriod();
  if (input.aiTokenCap !== null) {
    const used = await db.query.mailboxSpamUsage.findFirst({
      where: (u, { eq }) => eq(u.mailboxId, input.mailboxId),
      columns: { period: true, tokensIn: true, tokensOut: true },
    });
    if (used && used.period === period && used.tokensIn + used.tokensOut >= input.aiTokenCap) {
      return null; // budget exhausted — fall back to the heuristic verdict
    }
  }

  const subject = input.parsed.subject ?? "(no subject)";
  const body = (input.parsed.text ?? stripHtml(input.parsed.html ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
  const from = input.parsed.from?.address ?? input.fromEnvelope;

  let result: { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    result = (await env.AI.run(AI_MODEL, {
      max_tokens: 64,
      messages: [
        {
          role: "system",
          content:
            'You are an email spam classifier. Reply ONLY with compact JSON: {"verdict":"clean|suspicious|spam","reason":"short"}. Be conservative — only "spam" for clearly unsolicited bulk, scams, phishing, or malware. Legitimate newsletters and transactional mail are "clean".',
        },
        { role: "user", content: `From: ${from}\nSubject: ${subject}\n\n${body}` },
      ],
    })) as typeof result;
  } catch {
    return null;
  }

  await recordUsage(
    db,
    input.mailboxId,
    period,
    result.usage?.prompt_tokens ?? 0,
    result.usage?.completion_tokens ?? 0,
  );

  return parseAiResponse(result.response ?? "");
}

export function parseAiResponse(text: string): AiVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { verdict?: string; reason?: string };
    const v = obj.verdict;
    if (v !== "clean" && v !== "suspicious" && v !== "spam") return null;
    return { verdict: v, reason: (obj.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

async function recordUsage(
  db: DB,
  mailboxId: string,
  period: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  await db
    .insert(mailboxSpamUsage)
    .values({ mailboxId, period, calls: 1, tokensIn, tokensOut, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: mailboxSpamUsage.mailboxId,
      set: {
        // Reset the running totals when a new month rolls over.
        period,
        calls: sql`case when ${mailboxSpamUsage.period} = ${period} then ${mailboxSpamUsage.calls} + 1 else 1 end`,
        tokensIn: sql`case when ${mailboxSpamUsage.period} = ${period} then ${mailboxSpamUsage.tokensIn} + ${tokensIn} else ${tokensIn} end`,
        tokensOut: sql`case when ${mailboxSpamUsage.period} = ${period} then ${mailboxSpamUsage.tokensOut} + ${tokensOut} else ${tokensOut} end`,
        updatedAt: new Date(),
      },
    });
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
