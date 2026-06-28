import type { DB } from "@cfmail/db";
import { attachment, message, thread } from "@cfmail/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";

const R2_DELETE_BATCH = 1000;
// D1 rejects a query with more than 100 bound parameters, so any `inArray` over
// a caller-supplied id list must be fed in chunks below that cap.
const SQL_VARS_LIMIT = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function collectThreadBlobKeys(db: DB, threadIds: string[]): Promise<string[]> {
  if (!threadIds.length) return [];
  const perChunk = await Promise.all(
    chunk(threadIds, SQL_VARS_LIMIT).map(async (ids) => {
      const [msgs, atts] = await Promise.all([
        db
          .select({ rawR2Key: message.rawR2Key, plainR2Key: message.plainR2Key })
          .from(message)
          .where(inArray(message.threadId, ids)),
        db
          .select({ r2Key: attachment.r2Key })
          .from(attachment)
          .innerJoin(message, eq(message.id, attachment.messageId))
          .where(inArray(message.threadId, ids)),
      ]);

      const keys: string[] = [];
      for (const m of msgs) {
        if (m.rawR2Key) keys.push(m.rawR2Key);
        if (m.plainR2Key) keys.push(m.plainR2Key);
      }
      for (const a of atts) keys.push(a.r2Key);
      return keys;
    }),
  );
  return perChunk.flat();
}

// Delete threads by id (cascading to their messages/attachments), chunked under
// D1's bound-parameter cap. Blobs (R2) have no FK cascade — collect + delete
// those first via collectThreadBlobKeys/deleteBlobs.
export async function deleteThreadsByIds(db: DB, ids: string[]): Promise<void> {
  await Promise.all(
    chunk(ids, SQL_VARS_LIMIT).map((part) => db.delete(thread).where(inArray(thread.id, part))),
  );
}

// R2 keys owned by a single message (its raw/plaintext `.eml` + attachment
// bytes) — collected before a per-message delete, which the FK cascade can't reach.
export async function collectMessageBlobKeys(db: DB, messageId: string): Promise<string[]> {
  const msgs = await db
    .select({ rawR2Key: message.rawR2Key, plainR2Key: message.plainR2Key })
    .from(message)
    .where(eq(message.id, messageId));

  const atts = await db
    .select({ r2Key: attachment.r2Key })
    .from(attachment)
    .where(eq(attachment.messageId, messageId));

  return [
    ...msgs.map((m) => m.rawR2Key).filter((k): k is string => Boolean(k)),
    ...msgs.map((m) => m.plainR2Key).filter((k): k is string => Boolean(k)),
    ...atts.map((a) => a.r2Key),
  ];
}

export async function collectMailboxBlobKeys(db: DB, mailboxId: string): Promise<string[]> {
  const msgs = await db
    .select({ rawR2Key: message.rawR2Key, plainR2Key: message.plainR2Key })
    .from(message)
    .where(eq(message.mailboxId, mailboxId));

  const atts = await db
    .select({ r2Key: attachment.r2Key })
    .from(attachment)
    .innerJoin(message, eq(message.id, attachment.messageId))
    .where(eq(message.mailboxId, mailboxId));

  return [
    ...msgs.map((m) => m.rawR2Key).filter((k): k is string => Boolean(k)),
    ...msgs.map((m) => m.plainR2Key).filter((k): k is string => Boolean(k)),
    ...atts.map((a) => a.r2Key),
  ];
}

export async function deleteBlobs(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    batches.push(keys.slice(i, i + R2_DELETE_BATCH));
  }
  await Promise.all(batches.map((batch) => env.BLOBS.delete(batch)));
}
