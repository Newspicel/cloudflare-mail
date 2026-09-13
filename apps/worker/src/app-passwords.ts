// App passwords: per-mailbox secrets for IMAP clients (schema: app_password).
// Generation and hashing live here so the settings API and the IMAP login path
// agree on the format. The plaintext is shown once; only the scrypt hash
// (Better Auth's hasher, same as account passwords) is stored.
/* eslint-disable no-await-in-loop -- candidate hashes are verified one at a time on purpose */

import type { DB } from "@cfmail/db";
import { appPassword, domain, mailbox, user } from "@cfmail/db/schema";
import { has, Perm } from "@cfmail/shared/permissions";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, or } from "drizzle-orm";
import { AppError } from "./errors.ts";
import { resolveAccess } from "./permissions.ts";
import { enforceRateLimit } from "./rate-limit.ts";

// No 0/1/i/l/o so the password survives being read aloud or retyped.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const LENGTH = 20;

export function generateAppPassword(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i % 5 === 4 && i < LENGTH - 1) out += "-";
  }
  return out;
}

// Clients (and people) drop or add the dashes; compare on the bare secret.
export function normalizeAppPassword(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashAppPassword(password: string): Promise<string> {
  return hashPassword(normalizeAppPassword(password));
}

export interface AppPasswordLogin {
  userId: string;
  mailboxId: string;
  address: string;
  perms: number;
}

// IMAP login: `username` is the mailbox address (or the user's sign-in email),
// `password` an app password issued for that user+mailbox. Access is
// re-checked through permissions.ts on every login, so a revoked membership
// stops working immediately. Throttled per username and per client IP.
export async function loginWithAppPassword(
  db: DB,
  username: string,
  password: string,
  clientIp: string | null,
): Promise<AppPasswordLogin | null> {
  const name = username.trim().toLowerCase();
  const secret = normalizeAppPassword(password);
  if (!name || !secret) return null;
  await enforceRateLimit(db, "imap-login", name, 10, 15 * 60 * 1000);
  if (clientIp) await enforceRateLimit(db, "imap-login-ip", clientIp, 30, 15 * 60 * 1000);

  const at = name.indexOf("@");
  const localPart = at === -1 ? name : name.slice(0, at);
  const domainName = at === -1 ? "" : name.slice(at + 1);

  const candidates = await db
    .select({
      id: appPassword.id,
      userId: appPassword.userId,
      mailboxId: appPassword.mailboxId,
      hash: appPassword.hash,
      localPart: mailbox.localPart,
      domainName: domain.name,
    })
    .from(appPassword)
    .innerJoin(mailbox, eq(mailbox.id, appPassword.mailboxId))
    .innerJoin(domain, eq(domain.id, mailbox.domainId))
    .innerJoin(user, eq(user.id, appPassword.userId))
    .where(
      or(and(eq(mailbox.localPart, localPart), eq(domain.name, domainName)), eq(user.email, name)),
    )
    .limit(20);

  for (const c of candidates) {
    if (!(await verifyPassword({ hash: c.hash, password: secret }))) continue;
    const access = await resolveAccess(db, c.userId, c.mailboxId);
    if (!access || !has(access.perms, Perm.READ)) {
      throw new AppError("forbidden", "mailbox access has been revoked");
    }
    await db.update(appPassword).set({ lastUsedAt: new Date() }).where(eq(appPassword.id, c.id));
    return {
      userId: c.userId,
      mailboxId: c.mailboxId,
      address: `${c.localPart}@${c.domainName}`,
      perms: access.perms,
    };
  }
  return null;
}
