import { EmailMessage } from "cloudflare:email";
import type { DB } from "@cfmail/db";
import { mailbox, ruleSendLog } from "@cfmail/db/schema";
import { and, count, eq, gt } from "drizzle-orm";
import type { Env } from "../env.ts";
import { escapeHtml } from "../lib/encoding.ts";
import { buildMime, type ParsedEmail } from "./mime.ts";
import type { RuleOutcome } from "./rules.ts";

const HOUR_MS = 60 * 60 * 1000;
const AUTO_REPLY_WINDOW_MS = 4 * 24 * HOUR_MS; // one vacation reply per sender / 4 days
// Anti-relay backstop: a misconfigured rule can't turn a mailbox into a sender
// to arbitrary addresses faster than this. Counts forwards + auto-replies.
const MAILBOX_HOURLY_CAP = 50;

export interface RuleSendContext {
  mailboxId: string;
  selfAddr: string; // canonical mailbox address — the From of every rule send
  domainName: string;
  outcome: RuleOutcome;
  parsed: ParsedEmail;
  envelopeFrom: string; // SMTP MAIL FROM, for bounce detection
}

// Fire a matched rule's outbound actions (forward copies, vacation auto-replies)
// after the message is stored. Best-effort by contract (invariant 8): every send
// is independently guarded and a throw is swallowed by the caller — delivery has
// already succeeded. Throttle + rate-cap state lives in `rule_send_log`.
export async function runRuleSends(env: Env, db: DB, ctx: RuleSendContext): Promise<void> {
  const { outcome } = ctx;
  if (outcome.forwards.length === 0 && outcome.autoReplies.length === 0) return;

  // Hourly budget across all auto-sends for this mailbox.
  const since = new Date(Date.now() - HOUR_MS);
  const [used] = await db
    .select({ n: count() })
    .from(ruleSendLog)
    .where(and(eq(ruleSendLog.mailboxId, ctx.mailboxId), gt(ruleSendLog.sentAt, since)));
  let budget = MAILBOX_HOURLY_CAP - (used?.n ?? 0);
  if (budget <= 0) return;

  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, ctx.mailboxId),
    columns: { displayName: true },
  });
  const fromName = mb?.displayName ?? undefined;
  const headerFrom = ctx.parsed.from?.address?.trim() || null;

  for (const fwd of outcome.forwards) {
    if (budget <= 0) break;
    // Don't forward back to ourselves — that would loop straight back in.
    if (fwd.to.trim().toLowerCase() === ctx.selfAddr.toLowerCase()) continue;
    const raw = buildForward(ctx, fromName, fwd.to);
    // eslint-disable-next-line no-await-in-loop -- sends are gated by the shared hourly budget, so each must settle before the next
    if (await trySend(env, ctx.selfAddr, fwd.to, raw)) {
      budget--;
      // eslint-disable-next-line no-await-in-loop -- sequential by design; see above
      await logSend(db, ctx, fwd.ruleId, "forward", fwd.to);
    }
  }

  // Auto-replies go to the header From and only to a "real" human sender.
  if (outcome.autoReplies.length === 0) return;
  if (!headerFrom || !shouldAutoReply(ctx, headerFrom)) return;

  for (const reply of outcome.autoReplies) {
    if (budget <= 0) break;
    // eslint-disable-next-line no-await-in-loop -- per-recipient throttle check must precede the send
    if (await repliedRecently(db, reply.ruleId, headerFrom)) continue;
    const raw = buildAutoReply(ctx, fromName, headerFrom, reply.subject, reply.body);
    // eslint-disable-next-line no-await-in-loop -- sends are gated by the shared hourly budget, so each must settle before the next
    if (await trySend(env, ctx.selfAddr, headerFrom, raw)) {
      budget--;
      // eslint-disable-next-line no-await-in-loop -- sequential by design; see above
      await logSend(db, ctx, reply.ruleId, "autoReply", headerFrom);
    }
  }
}

// Whether an inbound message is eligible for a vacation auto-reply. Skips
// automated/bulk/list mail, bounces, and self — the standard backscatter guards.
function shouldAutoReply(ctx: RuleSendContext, headerFrom: string): boolean {
  if (headerFrom.toLowerCase() === ctx.selfAddr.toLowerCase()) return false;

  const env = ctx.envelopeFrom.trim().toLowerCase();
  // Empty envelope sender = a bounce/DSN; never reply (would loop or backscatter).
  if (!env) return false;
  const localPart = (headerFrom.split("@")[0] ?? "").toLowerCase();
  if (/^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply)$/.test(localPart)) {
    return false;
  }

  const autoSubmitted = header(ctx.parsed, "auto-submitted");
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") return false;
  // List / bulk mail — don't answer a newsletter.
  if (header(ctx.parsed, "list-id") || header(ctx.parsed, "list-unsubscribe")) return false;
  const precedence = header(ctx.parsed, "precedence")?.toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return false;

  return true;
}

async function repliedRecently(db: DB, ruleId: string, recipient: string): Promise<boolean> {
  const since = new Date(Date.now() - AUTO_REPLY_WINDOW_MS);
  const rows = await db
    .select({ id: ruleSendLog.id })
    .from(ruleSendLog)
    .where(
      and(
        eq(ruleSendLog.ruleId, ruleId),
        eq(ruleSendLog.recipient, recipient.toLowerCase()),
        gt(ruleSendLog.sentAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function trySend(env: Env, from: string, to: string, raw: string): Promise<boolean> {
  try {
    await env.EMAIL.send(new EmailMessage(from, to, raw));
    return true;
  } catch {
    return false;
  }
}

async function logSend(
  db: DB,
  ctx: RuleSendContext,
  ruleId: string,
  kind: "forward" | "autoReply",
  recipient: string,
): Promise<void> {
  await db
    .insert(ruleSendLog)
    .values({
      id: crypto.randomUUID(),
      mailboxId: ctx.mailboxId,
      ruleId,
      kind,
      recipient: recipient.toLowerCase(),
    })
    .catch(() => {});
}

function buildForward(ctx: RuleSendContext, fromName: string | undefined, to: string): string {
  const p = ctx.parsed;
  const subject = `Fwd: ${p.subject ?? "(no subject)"}`;
  const banner = [
    "---------- Forwarded message ----------",
    `From: ${formatAddr(p.from)}`,
    p.date ? `Date: ${p.date}` : null,
    `Subject: ${p.subject ?? ""}`,
    `To: ${formatAddrs(p.to)}`,
    "",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const text = banner + (p.text ?? "");
  const html = p.html
    ? `<p style="color:#6b7280">---------- Forwarded message ----------<br>` +
      `From: ${escapeHtml(formatAddr(p.from))}<br>` +
      `Subject: ${escapeHtml(p.subject ?? "")}<br>` +
      `To: ${escapeHtml(formatAddrs(p.to))}</p>${p.html}`
    : undefined;
  const attachments = (p.attachments ?? []).map((att, idx) => ({
    filename: att.filename ?? `file-${idx}`,
    contentType: att.mimeType ?? "application/octet-stream",
    data:
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content),
    // Preserve cid: images so the forwarded HTML keeps rendering them inline.
    inline: att.disposition === "inline" || !!att.contentId,
    contentId: att.contentId ?? undefined,
  }));
  return buildMime({
    messageId: `<${crypto.randomUUID()}@${ctx.domainName}>`,
    from: { name: fromName, address: ctx.selfAddr },
    to: [{ address: to }],
    // Hitting reply on a forward should reach the original sender, not us.
    replyTo: ctx.parsed.from?.address ?? undefined,
    subject,
    text,
    html,
    attachments,
    extraHeaders: { "Auto-Submitted": "auto-forwarded" },
  });
}

function buildAutoReply(
  ctx: RuleSendContext,
  fromName: string | undefined,
  to: string,
  subject: string | undefined,
  body: string,
): string {
  const origId = ctx.parsed.messageId ?? undefined;
  return buildMime({
    messageId: `<${crypto.randomUUID()}@${ctx.domainName}>`,
    from: { name: fromName, address: ctx.selfAddr },
    to: [{ address: to }],
    inReplyTo: origId,
    references: origId ? [origId] : undefined,
    subject: subject?.trim() || `Re: ${ctx.parsed.subject ?? ""}`.trim(),
    text: body,
    // Mark as an auto-reply so well-behaved senders won't bounce-loop on it.
    extraHeaders: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
  });
}

function header(parsed: ParsedEmail, name: string): string | null {
  return (parsed.headers ?? []).find((h) => h.key.toLowerCase() === name)?.value?.trim() || null;
}

function formatAddr(a: { name?: string; address?: string } | undefined): string {
  if (!a?.address) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function formatAddrs(addrs: unknown): string {
  if (!Array.isArray(addrs)) return "";
  return addrs
    .map((a) => formatAddr(a as { name?: string; address?: string }))
    .filter(Boolean)
    .join(", ");
}
