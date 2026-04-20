import { makeDB } from "@cfmail/db";
import { attachment, mailbox, message } from "@cfmail/db/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Env } from "./env.ts";
import { broadcastToUsers } from "./hub.ts";

export async function runCron(env: Env, now: Date): Promise<void> {
  const db = makeDB(env.DB);

  const expired = await db
    .select({ id: mailbox.id, ownerUserId: mailbox.ownerUserId })
    .from(mailbox)
    .where(and(eq(mailbox.type, "temp"), isNotNull(mailbox.expiresAt), lte(mailbox.expiresAt, now)))
    .limit(100);

  for (const mb of expired) {
    const msgs = await db
      .select({ id: message.id, rawR2Key: message.rawR2Key })
      .from(message)
      .where(eq(message.mailboxId, mb.id));

    const atts = msgs.length
      ? await db
          .select({ r2Key: attachment.r2Key })
          .from(attachment)
          .innerJoin(message, eq(message.id, attachment.messageId))
          .where(eq(message.mailboxId, mb.id))
      : [];

    const keys = [
      ...msgs.map((m) => m.rawR2Key).filter((k): k is string => Boolean(k)),
      ...atts.map((a) => a.r2Key),
    ];
    if (keys.length) await env.BLOBS.delete(keys);

    await db.delete(mailbox).where(eq(mailbox.id, mb.id));

    await broadcastToUsers(env, [mb.ownerUserId], {
      type: "mailbox_expired",
      mailboxId: mb.id,
    });
  }
}
