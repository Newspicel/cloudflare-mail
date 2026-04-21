import { makeDB } from "@cfmail/db";
import { domain, mailbox } from "@cfmail/db/schema";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Env } from "./env.ts";
import { broadcastToUsers } from "./hub.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "./mail/blobs.ts";
import { checkDomainHealth } from "./mail/dns.ts";

const DNS_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
const DNS_BATCH_LIMIT = 10;

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

  const stale = new Date(now.getTime() - DNS_RECHECK_INTERVAL_MS);
  const dueDomains = await db
    .select({ id: domain.id, name: domain.name })
    .from(domain)
    .where(or(isNull(domain.lastCheckedAt), lte(domain.lastCheckedAt, stale)))
    .limit(DNS_BATCH_LIMIT);

  await Promise.all(
    dueDomains.map(async (d) => {
      try {
        const health = await checkDomainHealth(d.name);
        await db
          .update(domain)
          .set({ ...health, lastCheckedAt: now })
          .where(eq(domain.id, d.id));
      } catch (err) {
        console.error(`dns check failed for ${d.name}`, err);
      }
    }),
  );
}
