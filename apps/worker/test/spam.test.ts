import type { DB } from "@cfmail/db";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import type { ParsedEmail } from "../src/mail/mime.ts";
import { evaluateSpam, parseAiResponse, parseAuthResults } from "../src/mail/spam.ts";

function parsed(opts: {
  authResults?: string;
  subject?: string;
  text?: string;
  from?: string;
}): ParsedEmail {
  const headers: { key: string; value: string }[] = [];
  if (opts.authResults) headers.push({ key: "authentication-results", value: opts.authResults });
  return {
    headers,
    subject: opts.subject ?? "Hello",
    text: opts.text ?? "Just a normal message.",
    from: { address: opts.from ?? "sender@elsewhere.com" },
    attachments: [],
  } as unknown as ParsedEmail;
}

// Auth/standard paths touch neither the AI binding nor the DB.
const fakeEnv = {} as Env;
const fakeDb = {} as DB;

function evalStandard(p: ParsedEmail) {
  return evaluateSpam(fakeEnv, fakeDb, {
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
