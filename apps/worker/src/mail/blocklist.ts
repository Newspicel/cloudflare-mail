import type { DB } from "@cfmail/db";
import { blocklist } from "@cfmail/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { getConfig, setConfig } from "../config.ts";

const PROTECTED_DOMAINS_KEY = "protected_domains";

// Big mailbox providers that may never be blocked at the domain level — blocking
// e.g. "gmail.com" would shut out an entire provider. Individual addresses on
// these domains can still be blocked. Admin-extendable (stored in system_config,
// invariant 7); this constant is the fallback when nothing is configured.
export const DEFAULT_PROTECTED_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "aol.com",
  "gmx.com",
  "gmx.net",
];

export async function getProtectedDomains(db: DB): Promise<string[]> {
  const raw = await getConfig(db, PROTECTED_DOMAINS_KEY);
  if (!raw) return DEFAULT_PROTECTED_DOMAINS;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : DEFAULT_PROTECTED_DOMAINS;
  } catch {
    return DEFAULT_PROTECTED_DOMAINS;
  }
}

export async function setProtectedDomains(db: DB, domains: string[]): Promise<void> {
  const normalized = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  await setConfig(db, PROTECTED_DOMAINS_KEY, JSON.stringify(normalized));
}

export async function isProtectedDomain(db: DB, domain: string): Promise<boolean> {
  const list = await getProtectedDomains(db);
  return list.includes(domain.trim().toLowerCase());
}

/** Domain plus each of its parent domains (e.g. a.b.com → [a.b.com, b.com]). */
function domainAndParents(domain: string): string[] {
  const parts = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

/**
 * True if any of the candidate sender addresses is hard-blocked — by an exact
 * address match or by a domain entry covering the sender's domain (or a parent
 * of it). Pass both the envelope sender and the header From so a spoofed From
 * can't slip a blocked envelope sender through, and vice versa.
 */
export async function isSenderBlocked(
  db: DB,
  candidates: (string | null | undefined)[],
): Promise<boolean> {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const cand of candidates) {
    const addr = cand?.trim().toLowerCase();
    if (!addr) continue;
    const at = addr.lastIndexOf("@");
    if (at <= 0 || at === addr.length - 1) continue;
    emails.add(addr);
    for (const d of domainAndParents(addr.slice(at + 1))) domains.add(d);
  }

  const conds = [];
  if (emails.size)
    conds.push(and(eq(blocklist.type, "email"), inArray(blocklist.value, [...emails])));
  if (domains.size)
    conds.push(and(eq(blocklist.type, "domain"), inArray(blocklist.value, [...domains])));
  if (conds.length === 0) return false;

  const rows = await db
    .select({ id: blocklist.id })
    .from(blocklist)
    .where(or(...conds))
    .limit(1);
  return rows.length > 0;
}

/**
 * Of the given addresses, returns the subset that is on the blocklist (by exact
 * address or a domain entry covering the address's domain / a parent). Used to
 * warn a composer about sending to a blocked recipient. Returns lowercased,
 * de-duplicated addresses.
 */
export async function blockedAddresses(db: DB, addresses: string[]): Promise<string[]> {
  const norm = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => {
    const at = a.lastIndexOf("@");
    return at > 0 && at !== a.length - 1;
  });
  if (norm.length === 0) return [];

  const domains = new Set<string>();
  for (const a of norm)
    for (const d of domainAndParents(a.slice(a.lastIndexOf("@") + 1))) domains.add(d);

  const rows = await db
    .select({ type: blocklist.type, value: blocklist.value })
    .from(blocklist)
    .where(
      or(
        and(eq(blocklist.type, "email"), inArray(blocklist.value, norm)),
        and(eq(blocklist.type, "domain"), inArray(blocklist.value, [...domains])),
      ),
    );
  const blockedEmails = new Set(rows.filter((r) => r.type === "email").map((r) => r.value));
  const blockedDomains = new Set(rows.filter((r) => r.type === "domain").map((r) => r.value));

  return norm.filter(
    (a) =>
      blockedEmails.has(a) ||
      domainAndParents(a.slice(a.lastIndexOf("@") + 1)).some((d) => blockedDomains.has(d)),
  );
}
