import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lookupAuthBl,
  lookupDomain,
  lookupIp,
  lookupNames,
  registrableDomain,
  verifyDqsKey,
} from "../src/mail/dnsbl.ts";

const KEY = "testkey123456789";

// Stubs the DoH endpoint: keys are "<queried labels>/<zone>", so a test states
// only what is listed and everything else answers NXDOMAIN.
function stubDoh(listings: Record<string, string[]>): () => string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const name = new URL(String(input)).searchParams.get("name") ?? "";
    asked.push(name);
    const subject = name.split(`.${KEY}.`)[0] ?? "";
    const zone = name.split(`.${KEY}.`)[1]?.split(".dq.")[0] ?? "";
    const codes = listings[`${subject}/${zone}`] ?? [];
    return Response.json({
      Status: codes.length ? 0 : 3,
      Answer: codes.map((data) => ({ name, type: 1, TTL: 60, data })),
    });
  });
  return () => asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("lookupIp", () => {
  it("reverses the address and queries the keyed zen zone", async () => {
    const asked = stubDoh({ "164.37.72.69/zen": ["127.0.0.4"] });
    expect(await lookupIp(KEY, "69.72.37.164")).toEqual({ kind: "xbl", code: "127.0.0.4" });
    expect(asked()).toEqual([`164.37.72.69.${KEY}.zen.dq.spamhaus.net`]);
  });

  it("reports the most severe of several return codes", async () => {
    // Spamhaus' own test point answers on SBL, CSS, XBL and PBL at once.
    stubDoh({ "2.0.0.127/zen": ["127.0.0.2", "127.0.0.3", "127.0.0.10", "127.0.0.4"] });
    expect(await lookupIp(KEY, "127.0.0.2")).toMatchObject({ kind: "sbl" });
  });

  it("returns null for an unlisted address, an error code and IPv6", async () => {
    stubDoh({ "1.0.0.127/zen": [], "9.9.9.9/zen": ["127.255.255.254"] });
    expect(await lookupIp(KEY, "127.0.0.1")).toBeNull();
    expect(await lookupIp(KEY, "9.9.9.9")).toBeNull();
    expect(await lookupIp(KEY, "2001:db8::1")).toBeNull();
  });

  it("survives a DNS failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await lookupIp(KEY, "1.2.3.4")).toBeNull();
  });
});

describe("lookupDomain", () => {
  it("prefers a DBL listing over ZRD's age signal", async () => {
    stubDoh({ "bad.example/dbl": ["127.0.1.5"], "bad.example/zrd": ["127.0.2.3"] });
    expect(await lookupDomain(KEY, "bad.example")).toEqual({
      domain: "bad.example",
      kind: "malware",
      code: "127.0.1.5",
    });
  });

  it("maps the abused-legit codes to their own kind", async () => {
    stubDoh({ "shortener.example/dbl": ["127.0.1.103"] });
    expect(await lookupDomain(KEY, "shortener.example")).toMatchObject({ kind: "abused" });
  });

  it("reads the domain age out of the ZRD return code", async () => {
    stubDoh({ "fresh.example/zrd": ["127.0.2.11"] });
    expect(await lookupDomain(KEY, "fresh.example")).toMatchObject({ kind: "new", ageHours: 11 });
  });

  it("ignores out-of-range and error codes", async () => {
    stubDoh({ "x.example/zrd": ["127.0.2.99"], "y.example/dbl": ["127.0.1.255"] });
    expect(await lookupDomain(KEY, "x.example")).toBeNull();
    expect(await lookupDomain(KEY, "y.example")).toBeNull();
  });
});

describe("lookupAuthBl", () => {
  it("only matches the AuthBL return code", async () => {
    stubDoh({ "2.0.0.127/authbl": ["127.0.0.20"], "4.3.2.1/authbl": ["127.0.0.2"] });
    expect(await lookupAuthBl(KEY, "127.0.0.2")).toBe(true);
    expect(await lookupAuthBl(KEY, "1.2.3.4")).toBe(false);
  });
});

describe("verifyDqsKey", () => {
  const workingKey = {
    "2.0.0.127/zen": ["127.0.0.2"],
    "dbltest.com/dbl": ["127.0.1.2"],
    "test/zrd": ["127.0.2.2"],
  };

  it("accepts a key that answers all three test points", async () => {
    stubDoh(workingKey);
    expect(await verifyDqsKey(KEY)).toEqual({ ok: true });
  });

  it("rejects a malformed key without querying", async () => {
    const asked = stubDoh(workingKey);
    expect(await verifyDqsKey("nope!")).toMatchObject({ ok: false });
    expect(asked()).toEqual([]);
  });

  it("rejects a key whose test lookups come back empty", async () => {
    stubDoh({});
    const r = await verifyDqsKey(KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/test lookup failed/);
  });

  it("surfaces a disabled key", async () => {
    stubDoh({ ...workingKey, "2.0.0.127/zen": ["127.255.255.250"] });
    expect(await verifyDqsKey(KEY)).toEqual({ ok: false, error: "this DQS key is disabled" });
  });

  it("rejects an IP-only key with no Content Data access", async () => {
    stubDoh({ "2.0.0.127/zen": ["127.0.0.2"] });
    expect(await verifyDqsKey(KEY)).toEqual({
      ok: false,
      error: "this key has no Content Data (DBL + ZRD) access",
    });
  });
});

describe("lookupNames", () => {
  it("expands a hostname to itself plus the domain under it", () => {
    expect(lookupNames("dbl-dqs.blt.spamhaus.net")).toEqual([
      "dbl-dqs.blt.spamhaus.net",
      "spamhaus.net",
    ]);
    expect(lookupNames("shop.example.co.uk")).toEqual(["shop.example.co.uk", "example.co.uk"]);
  });

  it("returns a single name when the host is already the domain", () => {
    expect(lookupNames("Example.com.")).toEqual(["example.com"]);
    expect(lookupNames("example.co.uk")).toEqual(["example.co.uk"]);
  });

  it("returns nothing for a host that cannot be listed", () => {
    expect(lookupNames("192.0.2.1")).toEqual([]);
    expect(lookupNames("localhost")).toEqual([]);
  });
});

describe("registrableDomain", () => {
  it("folds a hostname down to the domain Spamhaus lists", () => {
    expect(registrableDomain("mail.eu.example.com")).toBe("example.com");
    expect(registrableDomain("Example.COM.")).toBe("example.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com.au")).toBe("example.com.au");
  });

  it("rejects what cannot be a listed domain", () => {
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("192.0.2.1")).toBeNull();
    expect(registrableDomain("a..b")).toBeNull();
    expect(registrableDomain("under_score.example")).toBeNull();
    expect(registrableDomain("")).toBeNull();
  });
});
