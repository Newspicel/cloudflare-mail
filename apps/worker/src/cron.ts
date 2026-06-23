import { makeDB } from "@cfmail/db";
import { domain, mailbox, thread } from "@cfmail/db/schema";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Env } from "./env.ts";
import { broadcastToUsers } from "./hub.ts";
import { collectMailboxBlobKeys, collectThreadBlobKeys, deleteBlobs } from "./mail/blobs.ts";
import { checkDomainHealth } from "./mail/dns.ts";

const DNS_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
const DNS_BATCH_LIMIT = 10;
// Threads trashed longer than this are permanently purged by the cron.
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TRASH_PURGE_LIMIT = 500;
// Service mailboxes keep mail for a fixed window, then the cron purges it —
// there is no user inbox, so retention is automatic rather than user-driven.
const SERVICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SERVICE_PURGE_LIMIT = 500;

export async function runCron(env: Env, now: Date): Promise<void> {
  const db = makeDB(env.DB);

  const expired = await db
    .select({ id: mailbox.id, ownerUserId: mailbox.ownerUserId })
    .from(mailbox)
    .where(and(eq(mailbox.type, "temp"), isNotNull(mailbox.expiresAt), lte(mailbox.expiresAt, now)))
    .limit(100);

  await Promise.all(
    expired.map(async (mb) => {
      const keys = await collectMailboxBlobKeys(db, mb.id);
      await deleteBlobs(env, keys);
      await db.delete(mailbox).where(eq(mailbox.id, mb.id));
      await broadcastToUsers(env, [mb.ownerUserId], {
        type: "mailbox_expired",
        mailboxId: mb.id,
      });
    }),
  );

  // Purge threads that have sat in the trash past the retention window.
  // Deleting the thread cascades to its messages/attachments via FKs; blobs
  // (R2) have no cascade, so drop those first.
  const trashCutoff = new Date(now.getTime() - TRASH_RETENTION_MS);
  const staleTrash = await db
    .select({ id: thread.id })
    .from(thread)
    .where(and(eq(thread.trashed, true), lte(thread.trashedAt, trashCutoff)))
    .limit(TRASH_PURGE_LIMIT);

  if (staleTrash.length) {
    const ids = staleTrash.map((t) => t.id);
    const keys = await collectThreadBlobKeys(db, ids);
    await deleteBlobs(env, keys);
    await db.delete(thread).where(inArray(thread.id, ids));
  }

  // Purge service-mailbox threads older than the retention window. Threads
  // whose newest message predates the cutoff are fully aged out.
  const svcCutoff = new Date(now.getTime() - SERVICE_RETENTION_MS);
  const staleSvc = await db
    .select({ id: thread.id })
    .from(thread)
    .innerJoin(mailbox, eq(thread.mailboxId, mailbox.id))
    .where(and(eq(mailbox.type, "service"), lte(thread.lastMsgAt, svcCutoff)))
    .limit(SERVICE_PURGE_LIMIT);

  if (staleSvc.length) {
    const ids = staleSvc.map((t) => t.id);
    const keys = await collectThreadBlobKeys(db, ids);
    await deleteBlobs(env, keys);
    await db.delete(thread).where(inArray(thread.id, ids));
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
