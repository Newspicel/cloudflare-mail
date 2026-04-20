import { makeDB } from "@cfmail/db";
import { mailbox } from "@cfmail/db/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Env } from "./env.ts";
import { broadcastToUsers } from "./hub.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "./mail/blobs.ts";

export async function runCron(env: Env, now: Date): Promise<void> {
  const db = makeDB(env.DB);

  const expired = await db
    .select({ id: mailbox.id, ownerUserId: mailbox.ownerUserId })
    .from(mailbox)
    .where(and(eq(mailbox.type, "temp"), isNotNull(mailbox.expiresAt), lte(mailbox.expiresAt, now)))
    .limit(100);

  for (const mb of expired) {
    const keys = await collectMailboxBlobKeys(db, mb.id);
    await deleteBlobs(env, keys);

    await db.delete(mailbox).where(eq(mailbox.id, mb.id));

    await broadcastToUsers(env, [mb.ownerUserId], {
      type: "mailbox_expired",
      mailboxId: mb.id,
    });
  }
}
