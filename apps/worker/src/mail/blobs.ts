import type { DB } from "@cfmail/db";
import { attachment, message } from "@cfmail/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";

const R2_DELETE_BATCH = 1000;

export async function collectThreadBlobKeys(db: DB, threadIds: string[]): Promise<string[]> {
  if (!threadIds.length) return [];
  const msgs = await db
    .select({ rawR2Key: message.rawR2Key })
    .from(message)
    .where(inArray(message.threadId, threadIds));

  const atts = await db
    .select({ r2Key: attachment.r2Key })
    .from(attachment)
    .innerJoin(message, eq(message.id, attachment.messageId))
    .where(inArray(message.threadId, threadIds));

  return [
    ...msgs.map((m) => m.rawR2Key).filter((k): k is string => Boolean(k)),
    ...atts.map((a) => a.r2Key),
  ];
}

export async function collectMailboxBlobKeys(db: DB, mailboxId: string): Promise<string[]> {
  const msgs = await db
    .select({ rawR2Key: message.rawR2Key })
    .from(message)
    .where(eq(message.mailboxId, mailboxId));

  const atts = await db
    .select({ r2Key: attachment.r2Key })
    .from(attachment)
    .innerJoin(message, eq(message.id, attachment.messageId))
    .where(eq(message.mailboxId, mailboxId));

  return [
    ...msgs.map((m) => m.rawR2Key).filter((k): k is string => Boolean(k)),
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
