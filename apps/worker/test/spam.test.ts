import type { DB } from "@cfmail/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import type { ParsedEmail } from "../src/mail/mime.ts";
import { evaluateSpam, parseAiResponse, parseAuthResults } from "../src/mail/spam.ts";

function parsed(opts: {
  authResults?: string;
  subject?: string;
  text?: string;
  html?: string;
  from?: string;
  received?: string[];
}): ParsedEmail {
  const headers: { key: string; value: string }[] = [];
  for (const value of opts.received ?? []) headers.push({ key: "received", value });
  if (opts.authResults) headers.push({ key: "authentication-results", value: opts.authResults });
  return {
    headers,
    subject: opts.subject ?? "Hello",
    text: opts.text ?? "Just a normal message.",
    html: opts.html,
    from: { address: opts.from ?? "sender@elsewhere.com" },
    attachments: [],
  } as unknown as ParsedEmail;
}

// Auth/standard paths touch neither the AI binding nor the DB beyond the one
// system_config read for the Spamhaus key.
const fakeEnv = {} as Env;

function dbWithDqsKey(key: string | null): DB {
  return {
    query: { systemConfig: { findFirst: async () => (key ? { value: key } : undefined) } },
  } as unknown as DB;
}

const fakeDb = dbWithDqsKey(null);

function evalStandard(p: ParsedEmail, db: DB = fakeDb) {
  return evaluateSpam(fakeEnv, db, {
    mailboxId: "m1",
    level: "standard",
    aiTokenCap: null,
    parsed: p,
    fromEnvelope: "sender@elsewhere.com",
  });
}

describe("parseAuthResults", () => {
  it("extracts spf/dkim/dmarc results case-insensitively", () => {
    const r = parseAuthResults(
      parsed({ authResults: "mx.cloudflare.net; SPF=pass; dkim=FAIL; dmarc=none" }),
    );
    expect(r).toEqual({ spf: "pass", dkim: "fail", dmarc: "none" });
  });

  it("falls back to Received-SPF when SPF is absent", () => {
    const p = {
      headers: [{ key: "received-spf", value: "Pass (google.com: domain of x)" }],
    } as unknown as ParsedEmail;
    expect(parseAuthResults(p).spf).toBe("pass");
  });

  it("returns empty when no auth headers are present", () => {
    expect(parseAuthResults({ headers: [] } as unknown as ParsedEmail)).toEqual({});
  });
});

describe("evaluateSpam — authentication", () => {
  it("trusts fully authenticated mail (dmarc=pass) without running heuristics", async () => {
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass", text: "you won a lottery!!!" }),
    );
    expect(r.verdict).toBe("clean");
    expect(r.folderSpam).toBe(false);
    expect(r.score).toBe(0);
  });

  it("files forged mail (dmarc=fail) as spam with a forgery reason", async () => {
    const r = await evalStandard(parsed({ authResults: "mx; spf=fail; dkim=fail; dmarc=fail" }));
    expect(r.verdict).toBe("spam");
    expect(r.folderSpam).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/DMARC/i);
  });

  it("treats missing DMARC (but passing SPF) as suspicious, not spam", async () => {
    const r = await evalStandard(parsed({ authResults: "mx; spf=pass; dkim=none; dmarc=none" }));
    expect(r.verdict).toBe("suspicious");
    expect(r.folderSpam).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("evaluateSpam — auth-only level ignores content", () => {
  it("does not escalate on spammy content when level is auth", async () => {
    const r = await evaluateSpam(fakeEnv, fakeDb, {
      mailboxId: "m1",
      level: "auth",
      aiTokenCap: null,
      parsed: parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=none",
        subject: "CONGRATULATIONS YOU WON",
        text: "claim your prize now!!! free money bitcoin",
      }),
      fromEnvelope: "x@y.com",
    });
    // Only the "no DMARC policy" signal counts at the auth level → suspicious.
    expect(r.verdict).toBe("suspicious");
  });
});

describe("evaluateSpam — heuristics (standard)", () => {
  it("escalates unauthenticated spammy content toward spam", async () => {
    const r = await evalStandard(
      parsed({
        subject: "CONGRATULATIONS, YOU WON THE LOTTERY",
        text: "Claim your prize now!!! Free money via bitcoin. Wire transfer required.",
      }),
    );
    expect(r.score).toBeGreaterThanOrEqual(5);
    expect(r.verdict).toBe("spam");
  });
});

describe("parseAiResponse", () => {
  it("parses a JSON verdict embedded in model output", () => {
    expect(parseAiResponse('Sure: {"verdict":"spam","reason":"phishing link"}')).toEqual({
      verdict: "spam",
      reason: "phishing link",
    });
  });

  it("rejects malformed or invalid verdicts", () => {
    expect(parseAiResponse("no json here")).toBeNull();
    expect(parseAiResponse('{"verdict":"maybe"}')).toBeNull();
  });
});

// ─── Spamhaus DQS ────────────────────────────────────────────────────────────

const DQS_KEY = "testkey123456789";

// Answers keyed by the leading labels of the query name, so a test only has to
// say "this domain is on DBL" — anything unlisted falls through to NXDOMAIN.
function stubDoh(listings: Record<string, string[]>): () => string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const name = new URL(String(input)).searchParams.get("name") ?? "";
    asked.push(name);
    const zone = name.split(`.${DQS_KEY}.`)[1]?.split(".dq.")[0] ?? "";
    const subject = name.split(`.${DQS_KEY}.`)[0] ?? "";
    const codes = listings[`${subject}/${zone}`] ?? [];
    return Response.json({
      Status: codes.length ? 0 : 3,
      Answer: codes.map((data) => ({ name, type: 1, TTL: 60, data })),
    });
  });
  return () => asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("evaluateSpam — Spamhaus DQS", () => {
  it("skips every lookup when no key is configured", async () => {
    const asked = stubDoh({});
    const r = await evalStandard(
      parsed({ received: ["from x (x [69.72.37.164]) by mx.cloudflare.net"] }),
    );
    expect(asked()).toEqual([]);
    expect(r.reasons.join(" ")).not.toMatch(/Spamhaus/);
  });

  it("scores a DBL-listed sender domain even when DMARC passes", async () => {
    stubDoh({ "elsewhere.com/dbl": ["127.0.1.4"] });
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.score).toBe(4);
    expect(r.verdict).toBe("suspicious");
    expect(r.reasons.join(" ")).toMatch(/sender domain \(elsewhere\.com\) is listed.*phishing/i);
  });

  it("leaves authenticated mail from unlisted domains clean", async () => {
    stubDoh({});
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r).toMatchObject({ verdict: "clean", score: 0, reasons: [] });
  });

  it("reports a ZRD-listed sender domain with its age", async () => {
    stubDoh({ "elsewhere.com/zrd": ["127.0.2.7"] });
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.score).toBe(2);
    expect(r.reasons.join(" ")).toMatch(/first seen 7 hours ago/);
  });

  it("queries the reversed relay IP from the topmost Received header", async () => {
    const asked = stubDoh({ "4.3.2.1/zen": ["127.0.0.2"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=none; dmarc=none",
        received: [
          "from relay.example (relay.example [1.2.3.4]) by mx.cloudflare.net",
          "from laptop (laptop [9.9.9.9]) by relay.example",
        ],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(asked()).toContain(`4.3.2.1.${DQS_KEY}.zen.dq.spamhaus.net`);
    expect(asked().join(" ")).not.toMatch(/9\.9\.9\.9/);
    // +2 no DMARC policy, +4 SBL → spam.
    expect(r.score).toBe(6);
    expect(r.verdict).toBe("spam");
    expect(r.reasons.join(" ")).toMatch(/sending IP \(1\.2\.3\.4\).*known spam source/i);
  });

  it("treats a PBL-only listing as a soft signal", async () => {
    stubDoh({ "4.3.2.1/zen": ["127.0.0.10", "127.0.0.11"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        received: ["from relay (relay [1.2.3.4]) by mx.cloudflare.net"],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    // DMARC passed, so the IP is never looked up at all.
    expect(r.verdict).toBe("clean");
  });

  it("scores a listed link domain below a listed sender domain, capped", async () => {
    stubDoh({ "spammy.example/dbl": ["127.0.1.2"], "worse.example/dbl": ["127.0.1.5"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        html: '<a href="https://a.spammy.example/x?y=1">click</a> <a href="http://worse.example">or</a>',
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.score).toBe(3); // 2 + 2, capped at LINK_SCORE_CAP
    expect(r.reasons.join(" ")).toMatch(/links to spammy\.example/);
  });

  it("ignores the 127.255.255.x error codes instead of reading them as listings", async () => {
    stubDoh({
      "4.3.2.1/zen": ["127.255.255.254"],
      "elsewhere.com/dbl": ["127.255.255.250"],
      "elsewhere.com/zrd": ["127.255.255.254"],
    });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        received: ["from relay (relay [1.2.3.4]) by mx.cloudflare.net"],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r).toMatchObject({ verdict: "clean", score: 0 });
  });

  it("makes no DQS query at the auth level", async () => {
    const asked = stubDoh({ "elsewhere.com/dbl": ["127.0.1.2"] });
    await evaluateSpam(fakeEnv, dbWithDqsKey(DQS_KEY), {
      mailboxId: "m1",
      level: "auth",
      aiTokenCap: null,
      parsed: parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=none" }),
      fromEnvelope: "sender@elsewhere.com",
    });
    expect(asked()).toEqual([]);
  });
});
