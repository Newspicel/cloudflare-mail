import type { DB } from "@cfmail/db";
import { systemConfig } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { importMasterKey } from "./mail/pgp.ts";

const SECRET_KEY = "auth_secret";
const PGP_MASTER_KEY = "pgp_master_key";

export async function getConfig(db: DB, key: string): Promise<string | null> {
  const row = await db.query.systemConfig.findFirst({
    where: eq(systemConfig.key, key),
    columns: { value: true },
  });
  return row?.value ?? null;
}

export async function setConfig(db: DB, key: string, value: string): Promise<void> {
  await db
    .insert(systemConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemConfig.key, set: { value, updatedAt: new Date() } });
}

// Returns the auth secret, generating + persisting one on first call.
// The INSERT-then-SELECT pattern handles concurrent isolates racing to
// initialise — only the first writer's value wins, others read it back.
export async function getOrCreateAuthSecret(db: DB): Promise<string> {
  const existing = await getConfig(db, SECRET_KEY);
  if (existing) return existing;
  const generated = randomBase64(32);
  await db
    .insert(systemConfig)
    .values({ key: SECRET_KEY, value: generated, updatedAt: new Date() })
    .onConflictDoNothing();
  const final = await getConfig(db, SECRET_KEY);
  if (!final) throw new Error("failed to persist auth secret");
  return final;
}

// Returns the gateway-PGP master key (CryptoKey) used to wrap mailbox private
// keys at rest, generating + persisting a 32-byte secret on first call. Same
// lazy-init/race pattern as the auth secret (invariant 7).
export async function getOrCreatePgpMasterKey(db: DB): Promise<CryptoKey> {
  let secret = await getConfig(db, PGP_MASTER_KEY);
  if (!secret) {
    await db
      .insert(systemConfig)
      .values({ key: PGP_MASTER_KEY, value: randomBase64(32), updatedAt: new Date() })
      .onConflictDoNothing();
    secret = await getConfig(db, PGP_MASTER_KEY);
    if (!secret) throw new Error("failed to persist pgp master key");
  }
  return importMasterKey(secret);
}

function randomBase64(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
