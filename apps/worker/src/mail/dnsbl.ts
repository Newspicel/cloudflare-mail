// Spamhaus DQS — authenticated DNSBL/DNSWL lookups over DoH.
//
// The free public zones (zen.spamhaus.org &c.) are unusable from a Worker: they
// refuse queries that arrive via a public resolver and answer 127.255.255.254
// for *every* name, and DoH is the only DNS a Worker has. DQS puts a per-account
// query key in the name instead, so the same lookups work through any resolver.
//
// Zone shapes (docs.spamhaus.com → Available Zones):
//   <reversed-ipv4>.<key>.zen.dq.spamhaus.net      SBL + CSS + XBL + PBL
//   <reversed-ipv4>.<key>.authbl.dq.spamhaus.net   credential-abuse sources
//   <domain>.<key>.dbl.dq.spamhaus.net             domain reputation
//   <domain>.<key>.zrd.dq.spamhaus.net             domains first seen <24h ago
//   <base32 sha256>._<ctx>.<key>.hbl.dq.spamhaus.net   hashed message content
//
// A listing answers inside 127.0.0.0/16, "not listed" is NXDOMAIN (no answer),
// and 127.255.255.0/24 carries errors (key disabled, key used from the wrong
// account, malformed query) — never a listing.

import type { DB } from "@cfmail/db";
import { getConfig, setConfig } from "../config.ts";
import { dohQuery } from "./dns.ts";

const DQS_KEY_CONFIG = "spamhaus_dqs_key";

// Keys are alphanumeric. Anything else could inject extra labels into the query
// name, so an unusable key is treated as no key at all.
const KEY_RE = /^[a-z0-9]{8,64}$/i;

// Spamhaus' own test points: these are permanently listed, so a query that
// comes back empty means the key isn't working rather than "nothing listed".
const TEST_IP = "127.0.0.2";
const TEST_ZRD_NAME = "test";
// SHA-256 of the EICAR test file, the hash Spamhaus keeps listed in HBL.
const TEST_HBL_HASH = "E5NAEG57WZEJ4VGUOGEZ67NZ2FTD7RUV5QX6FIWEKOFKX5SR7UHQ";

export type IpListKind = "drop" | "sbl" | "css" | "bcl" | "xbl" | "pbl";
export type DomainListKind = "phish" | "malware" | "botnet" | "spam" | "abused" | "new";

export interface IpListing {
  kind: IpListKind;
  /** The raw return code, for logs. */
  code: string;
}

export interface DomainListing {
  domain: string;
  kind: DomainListKind;
  code: string;
  /** ZRD only: how long ago the domain was first observed, in hours. */
  ageHours?: number;
}

// HBL hashes message content rather than naming it, so a lookup reveals nothing
// about the message. Each context has its own normalisation before hashing.
export type HblContext = "email" | "file" | "cw" | "url";
export type HblKind =
  | "spam-email"
  | "malware-file"
  | "suspicious-file"
  | "spam-wallet"
  | "spam-url";

export interface HblListing {
  kind: HblKind;
  code: string;
}

// ─── Key storage (invariant 4: no deployment values in the repo) ─────────────

export interface DqsConfig {
  key: string;
  /** Whether this key's plan includes the Hash Blocklist. */
  hbl: boolean;
}

// Stored as JSON so the plan travels with the key and the mail path needs one
// read; a bare string is a key saved before the tier was recorded.
export async function getDqsConfig(db: DB): Promise<DqsConfig | null> {
  const raw = (await getConfig(db, DQS_KEY_CONFIG))?.trim();
  if (!raw) return null;
  const parsed = raw.startsWith("{") ? parseConfig(raw) : { key: raw, hbl: false };
  return parsed && KEY_RE.test(parsed.key) ? parsed : null;
}

function parseConfig(raw: string): DqsConfig | null {
  try {
    const v = JSON.parse(raw) as Partial<DqsConfig>;
    return typeof v.key === "string" ? { key: v.key, hbl: v.hbl === true } : null;
  } catch {
    return null;
  }
}

/** Stores a key and its plan, or clears both when given an empty key. */
export async function setDqsConfig(db: DB, key: string, hbl: boolean): Promise<void> {
  const trimmed = key.trim();
  const value = KEY_RE.test(trimmed) ? JSON.stringify({ key: trimmed, hbl }) : "";
  await setConfig(db, DQS_KEY_CONFIG, value);
}

export interface DqsKeyCheck {
  ok: boolean;
  error?: string;
  /** Whether the key answered the HBL test point too. */
  hbl?: boolean;
}

/**
 * Validates a key against the ZEN + DBL + ZRD test points before it is stored,
 * so a typo or a disabled key surfaces at save time instead of silently
 * degrading every later lookup.
 */
export async function verifyDqsKey(key: string): Promise<DqsKeyCheck> {
  if (!KEY_RE.test(key)) return { ok: false, error: "not a DQS query key" };
  // Raw answers here: an error code is the diagnosis we want to report, not
  // something to swallow the way a live lookup does.
  const [zen, dbl, zrd, hbl] = await Promise.all([
    rawAnswers(zoneName(reverseIpv4(TEST_IP)!, key, "zen")),
    rawAnswers(zoneName("dbltest.com", key, "dbl")),
    rawAnswers(zoneName(TEST_ZRD_NAME, key, "zrd")),
    // The EICAR hash is permanently listed; a plan without HBL answers nothing.
    rawAnswers(`${TEST_HBL_HASH}._file.${key}.hbl.dq.spamhaus.net`),
  ]);

  const err = [...zen, ...dbl, ...zrd].find(isErrorCode);
  if (err) return { ok: false, error: errorMessage(err) };
  if (!zen.includes("127.0.0.2")) {
    return { ok: false, error: "the IP Data test lookup failed — is this key active?" };
  }
  if (!dbl.includes("127.0.1.2") || !zrd.includes("127.0.2.2")) {
    return { ok: false, error: "this key has no Content Data (DBL + ZRD) access" };
  }
  return { ok: true, hbl: hbl.includes("127.0.3.10") };
}

// ─── Lookups ────────────────────────────────────────────────────────────────

/** ZEN: is the relay that delivered this message a known bad source? */
export async function lookupIp(key: string, ip: string): Promise<IpListing | null> {
  const rev = reverseIpv4(ip);
  if (!rev) return null;
  return pickIp(await answers(zoneName(rev, key, "zen")));
}

/** AuthBL: is this IP a known source of credential brute-forcing? */
export async function lookupAuthBl(key: string, ip: string): Promise<boolean> {
  const rev = reverseIpv4(ip);
  if (!rev) return false;
  return (await answers(zoneName(rev, key, "authbl"))).includes("127.0.0.20");
}

/**
 * DBL + ZRD for one domain, queried together — a DBL listing outranks "this
 * domain is hours old", but both cost the same single round trip in parallel.
 */
export async function lookupDomain(key: string, domain: string): Promise<DomainListing | null> {
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  const [dbl, zrd] = await Promise.all([
    answers(zoneName(domain, key, "dbl")),
    answers(zoneName(domain, key, "zrd")),
  ]);
  return pickDbl(domain, dbl) ?? pickZrd(domain, zrd);
}

/**
 * HBL: is this piece of content — an address, a wallet, a URL, a file — one
 * Spamhaus has seen in spam? `value` is hashed here and never sent.
 */
export async function lookupHbl(
  key: string,
  context: HblContext,
  value: string | Uint8Array,
): Promise<HblListing | null> {
  const hash = await hblHash(value);
  const codes = await answers(`${hash}._${context}.${key}.hbl.dq.spamhaus.net`);
  for (const [code, kind] of HBL_CODES) {
    if (codes.includes(code)) return { kind, code };
  }
  return null;
}

/** SHA-256 of the value, BASE32 without padding — the shape HBL queries take. */
export async function hblHash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of digest) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * The normalised forms of an address before hashing, per HBL's rules: lowercase
 * it, drop any `+tag`, fold googlemail onto gmail and drop the dots Gmail
 * ignores. Returns null when it isn't an address at all.
 */
export function normalizeEmail(address: string): string | null {
  const at = address.trim().toLowerCase().lastIndexOf("@");
  const lower = address.trim().toLowerCase();
  if (at <= 0 || at === lower.length - 1) return null;
  let local = lower.slice(0, at).split("+")[0]!;
  let domain = lower.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return local && normalizeHost(domain) ? `${local}@${domain}` : null;
}

/**
 * The forms of a URL to look up: scheme dropped, host lowercased, path kept as
 * sent — plus an all-lowercase variant, which is what Spamhaus' own catch-all
 * test domain hashes. (The per-domain variation rules ship as a YAML we don't
 * carry; these two cover the cases their test set exercises.)
 */
export function urlHashForms(url: string): string[] {
  const m = url.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)([^\s]*)$/i);
  if (!m) return [];
  const host = normalizeHost(m[1]!.split("@").at(-1)!.split(":")[0]!);
  if (!host) return [];
  const rest = m[2] === "/" ? "" : m[2];
  const canonical = `${host}${rest}`;
  const lowered = canonical.toLowerCase();
  return canonical === lowered ? [canonical] : [canonical, lowered];
}

// ─── Return-code parsing ────────────────────────────────────────────────────

const HBL_CODES: [string, HblKind][] = [
  ["127.0.3.10", "malware-file"],
  ["127.0.3.15", "suspicious-file"],
  ["127.0.3.30", "spam-url"],
  ["127.0.3.20", "spam-wallet"],
  ["127.0.3.2", "spam-email"],
];

// ZEN, most severe first — a single IP routinely answers with several codes.
const IP_CODES: [string, IpListKind][] = [
  ["127.0.0.9", "drop"],
  ["127.0.0.2", "sbl"],
  ["127.0.0.3", "css"],
  ["127.0.0.30", "bcl"],
  ["127.0.0.4", "xbl"],
  ["127.0.0.5", "xbl"],
  ["127.0.0.6", "xbl"],
  ["127.0.0.7", "xbl"],
  ["127.0.0.10", "pbl"],
  ["127.0.0.11", "pbl"],
];

function pickIp(list: string[]): IpListing | null {
  for (const [code, kind] of IP_CODES) if (list.includes(code)) return { kind, code };
  return null;
}

// DBL, most severe first. 127.0.1.10x are "abused legit" — a real domain caught
// hosting someone else's spam, so they carry far less weight than an outright
// spam domain.
const DBL_CODES: [string, DomainListKind][] = [
  ["127.0.1.6", "botnet"],
  ["127.0.1.5", "malware"],
  ["127.0.1.4", "phish"],
  ["127.0.1.2", "spam"],
  ["127.0.1.106", "abused"],
  ["127.0.1.105", "abused"],
  ["127.0.1.104", "abused"],
  ["127.0.1.103", "abused"],
  ["127.0.1.102", "abused"],
];

function pickDbl(domain: string, list: string[]): DomainListing | null {
  for (const [code, kind] of DBL_CODES) {
    if (list.includes(code)) return { domain, kind, code };
  }
  return null;
}

// ZRD answers 127.0.2.[2..24] where the last octet is the age in hours.
function pickZrd(domain: string, list: string[]): DomainListing | null {
  for (const code of list) {
    const m = code.match(/^127\.0\.2\.(\d+)$/);
    const age = m ? Number(m[1]) : Number.NaN;
    if (age >= 2 && age <= 24) return { domain, kind: "new", code, ageHours: age };
  }
  return null;
}

function isErrorCode(code: string): boolean {
  return code.startsWith("127.255.255.");
}

function errorMessage(code: string): string {
  if (code === "127.255.255.250") return "this DQS key is disabled";
  if (code === "127.255.255.251") return "this DQS key is in use by another account";
  return `Spamhaus returned an error (${code})`;
}

// ─── Query plumbing ─────────────────────────────────────────────────────────

function zoneName(prefix: string, key: string, zone: "zen" | "authbl" | "dbl" | "zrd"): string {
  return `${prefix}.${key}.${zone}.dq.spamhaus.net`;
}

async function rawAnswers(name: string): Promise<string[]> {
  try {
    return await dohQuery(name, "A");
  } catch {
    return [];
  }
}

// Every lookup is best-effort (invariant 8): a DNS failure, an error code or a
// malformed answer reads as "not listed" and never blocks mail or a login. An
// error code is logged, since it means every lookup is silently degraded.
async function answers(name: string): Promise<string[]> {
  const out = await rawAnswers(name);
  const err = out.find(isErrorCode);
  if (err) {
    console.error(`spamhaus dqs: ${errorMessage(err)}`);
    return [];
  }
  return out;
}

function reverseIpv4(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null; // IPv6 needs nibble form; not queried
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.toReversed().join(".");
}

// ─── Domain normalisation ───────────────────────────────────────────────────

// DBL and ZRD list registered domains, so a hostname has to be folded down to
// its registrable form or the query is a guaranteed NXDOMAIN. A full public
// suffix list is far too heavy for the mail path — these are the multi-label
// suffixes that actually show up in mail.
const MULTI_LABEL_SUFFIXES = new Set([
  "ac.uk",
  "co.at",
  "co.il",
  "co.in",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.uk",
  "co.za",
  "com.ar",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
  "com.ua",
  "gov.uk",
  "net.au",
  "net.br",
  "or.jp",
  "org.au",
  "org.br",
  "org.uk",
]);

/** Lowercases and validates a hostname, or null if it can't be a listed name. */
export function normalizeHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return null;
  const labels = h.split(".");
  if (labels.length < 2 || labels.some((l) => l === "")) return null;
  if (/^\d+$/.test(labels.at(-1)!)) return null; // IPv4 literal
  return h;
}

/** Folds a hostname to the domain Spamhaus would list, or null if unusable. */
export function registrableDomain(host: string): string | null {
  const h = normalizeHost(host);
  if (!h) return null;
  const labels = h.split(".");
  const base = labels.slice(-2).join(".");
  if (labels.length > 2 && MULTI_LABEL_SUFFIXES.has(base)) return labels.slice(-3).join(".");
  return base;
}

/**
 * The names to query for one hostname: the hostname itself and, when different,
 * the domain it sits under. DBL and ZRD list both — `dbl-dqs.blt.spamhaus.net`
 * is listed while `spamhaus.net` is not — so folding to the registrable domain
 * alone silently misses every listing that names a subdomain.
 */
export function lookupNames(host: string): string[] {
  const full = normalizeHost(host);
  if (!full) return [];
  const base = registrableDomain(full);
  return base && base !== full ? [full, base] : [full];
}
