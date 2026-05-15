import type { DB } from "@cfmail/db";
import { systemConfig } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";

const SECRET_KEY = "auth_secret";

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

function randomBase64(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
