// BIMI — Brand Indicators for Message Identification. A domain publishes a
// logo at `default._bimi.<domain>` TXT; mail clients show it beside messages
// from that domain instead of an initial.
//
// Two things this deliberately does *not* do:
//
//   * It does not verify the `a=` Verified Mark Certificate. Doing that
//     properly means X.509 chain validation against the BIMI CA set, which the
//     Worker has no business attempting. The record's authority claim is stored
//     and surfaced as *asserted*, never as verified.
//   * It does not gate on DMARC. A logo is decoration, not a trust signal, and
//     the reader already gets real provenance from the spam/auth banner. Nothing
//     here should ever make a message look more trustworthy than it is.
//
// A lookup is a DNS query plus an HTTPS fetch, so results — including misses,
// which are the overwhelming majority — are cached in D1 with a TTL.

import type { DB } from "@cfmail/db";
import { bimiLogo } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { safeRedirectFetch } from "../ssrf.ts";
import { dohQuery } from "./dns.ts";

/** The BIMI draft caps a logo at 32 KB; refuse anything beyond that. */
const MAX_SVG_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

/** How long a result stays good. Misses are re-checked sooner than hits. */
const TTL_FOUND_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_MISS_MS = 24 * 60 * 60 * 1000;

export interface BimiLogo {
  svg: string;
  /** Whether the record carried an `a=` mark certificate URL (not verified). */
  hasAuthority: boolean;
}

/**
 * The logo for a domain, or null. Never throws: every failure path — no record,
 * bad SVG, DNS down, fetch refused — is a cached miss, because a missing logo
 * is the normal case and must cost nothing on the next message.
 */
export async function resolveBimiLogo(db: DB, domain: string): Promise<BimiLogo | null> {
  const name = normalizeDomain(domain);
  if (!name) return null;

  const cached = await cachedBimiLogo(db, name);
  if (cached !== "stale") return cached;

  const found = await fetchBimiIndicator(name);
  await remember(db, name, found);
  return found ? { svg: found.svg, hasAuthority: found.hasAuthority } : null;
}

/**
 * The cached answer for a domain, or `"stale"` when a network lookup is needed.
 *
 * Callers use this to decide whether a request costs anything: a reader opening
 * a mailbox asks about every correspondent at once, and the overwhelming
 * majority are remembered misses. Only a genuine miss should count against a
 * rate limit.
 */
export async function cachedBimiLogo(db: DB, domain: string): Promise<BimiLogo | null | "stale"> {
  const name = normalizeDomain(domain);
  if (!name) return null;
  const cached = await db.query.bimiLogo.findFirst({ where: eq(bimiLogo.domain, name) });
  if (!cached || cached.expiresAt.getTime() <= Date.now()) return "stale";
  return cached.status === "ok" && cached.svg
    ? { svg: cached.svg, hasAuthority: cached.hasAuthority }
    : null;
}

export interface BimiIndicator extends BimiLogo {
  source: string;
}

/**
 * Resolve and fetch a domain's indicator, with no caching. Exported so the
 * record parsing and SVG handling can be tested without a database.
 */
export async function fetchBimiIndicator(domain: string): Promise<BimiIndicator | null> {
  let records: string[];
  try {
    records = await dohQuery(`default._bimi.${domain}`, "TXT");
  } catch {
    return null;
  }

  const record = records.find((r) => /^\s*v\s*=\s*BIMI1\b/i.test(r));
  if (!record) return null;

  const tags = parseTags(record);
  const location = tags.get("l");
  // `l=` present but empty is the spec's way of saying "deliberately no logo".
  if (!location) return null;

  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  // The indicator must be fetched over TLS; anything else isn't a BIMI record
  // worth honouring.
  if (url.protocol !== "https:") return null;

  const svg = await fetchSvg(url);
  if (!svg) return null;
  return { svg, hasAuthority: Boolean(tags.get("a")), source: url.toString() };
}

async function fetchSvg(url: URL): Promise<string | null> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response | { blocked: true; reason: string };
  try {
    res = await safeRedirectFetch(url, {
      signal,
      headers: { accept: "image/svg+xml,image/*;q=0.5" },
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit);
  } catch {
    return null;
  }
  if ("blocked" in res || !res.ok) return null;

  const type = res.headers.get("content-type") ?? "";
  // Some CDNs serve SVG as octet-stream; accept that, refuse anything that
  // claims to be another image format (it wouldn't be a BIMI indicator).
  if (type && !/svg|xml|octet-stream/i.test(type)) return null;

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_SVG_BYTES) return null;

  const body = await res.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_SVG_BYTES) return null;

  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body);
  if (!/<svg[\s>]/i.test(text)) return null;
  return sanitizeSvg(text);
}

/**
 * Strip everything an SVG can do besides draw.
 *
 * The served bytes are already defanged at the transport level — `img` context,
 * `nosniff`, and a sandboxing CSP — but a BIMI indicator is SVG Tiny PS, a
 * profile with no scripting, no external references and no interactivity at
 * all. Anything here that looks like those features is a sign the file isn't
 * what it claims to be, so it goes.
 */
export function sanitizeSvg(svg: string): string | null {
  let out = svg
    // Script and anything that can pull in or run foreign content.
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<(script|foreignObject|iframe|embed|object|audio|video|animate|set)\b[^>]*\/?>/gi, "")
    // Inline event handlers (`onload=`, `onclick=`, …).
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // javascript: / data: targets in href/xlink:href.
    .replace(
      /\s(?:xlink:)?href\s*=\s*(?:"(?:javascript|data):[^"]*"|'(?:javascript|data):[^']*'|(?:javascript|data):[^\s>]+)/gi,
      "",
    );

  // An external reference would let the logo host watch the reader; the profile
  // forbids them, so their presence means this isn't a usable indicator.
  if (/<image\b/i.test(out) || /url\(\s*['"]?https?:/i.test(out)) return null;
  if (/<!ENTITY/i.test(out)) return null;

  out = out.trim();
  return out.length > 0 && out.length <= MAX_SVG_BYTES ? out : null;
}

async function remember(db: DB, domain: string, found: BimiIndicator | null): Promise<void> {
  const now = new Date();
  const row = {
    domain,
    status: found ? ("ok" as const) : ("none" as const),
    svg: found?.svg ?? null,
    source: found?.source ?? null,
    hasAuthority: found?.hasAuthority ?? false,
    fetchedAt: now,
    expiresAt: new Date(Date.now() + (found ? TTL_FOUND_MS : TTL_MISS_MS)),
  };
  try {
    await db.insert(bimiLogo).values(row).onConflictDoUpdate({ target: bimiLogo.domain, set: row });
  } catch (err) {
    // A cache write failing is not worth failing the request over.
    console.error("bimi cache write failed", err);
  }
}

/** Tag list parsing: `v=BIMI1; l=https://…/logo.svg; a=https://…/vmc.pem`. */
function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const split = part.indexOf("=");
    if (split === -1) continue;
    const key = part.slice(0, split).trim().toLowerCase();
    const value = part.slice(split + 1).trim();
    if (key) tags.set(key, value);
  }
  return tags;
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** Lowercased, trailing-dot-free, and actually a domain — or null. */
export function normalizeDomain(input: string): string | null {
  const name = input.trim().toLowerCase().replace(/\.+$/, "");
  if (name.length === 0 || name.length > 253) return null;
  return DOMAIN_RE.test(name) ? name : null;
}

/** The domain half of an address, for looking a logo up from a `From:`. */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at === -1 ? null : normalizeDomain(address.slice(at + 1));
}
