import { type DB, makeDB } from "@cfmail/db";
import { domain, draft, mailbox, reminder, thread } from "@cfmail/db/schema";
import { and, asc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Env } from "./env.ts";
import { broadcastToUsers } from "./hub.ts";
import {
  collectMailboxBlobKeys,
  collectThreadBlobKeys,
  deleteBlobs,
  deleteThreadsByIds,
} from "./mail/blobs.ts";
import { checkDomainHealth } from "./mail/dns.ts";
import { pushToUsers } from "./mail/push.ts";
import { buildQuote } from "./mail/quote.ts";
import { sendFromMailbox } from "./mail/send.ts";

const DNS_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
const DNS_BATCH_LIMIT = 10;
// Threads trashed longer than this are permanently purged by the cron.
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TRASH_PURGE_LIMIT = 500;
// Service mailboxes keep mail for a fixed window, then the cron purges it —
// there is no user inbox, so retention is automatic rather than user-driven.
const SERVICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SERVICE_PURGE_LIMIT = 500;
// How many due scheduled sends to dispatch per cron tick.
const SCHEDULED_SEND_LIMIT = 50;
// How many due reminders to fire per cron tick.
const REMINDER_LIMIT = 100;
// A failing scheduled send is retried on subsequent ticks up to this many times
// before it's marked failed.
const SCHEDULED_SEND_MAX_ATTEMPTS = 3;

export async function runCron(env: Env, now: Date): Promise<void> {
  const db = makeDB(env.DB);

  await dispatchScheduledSends(env, db, now);
  await dispatchReminders(env, db, now);

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
    await deleteThreadsByIds(db, ids);
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
    await deleteThreadsByIds(db, ids);
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

// Fire reminders whose time has arrived: mark them fired, push a notification to
// the owner's devices, and broadcast over SSE so the bell updates live. A
// per-row failure is logged but never aborts the batch.
async function dispatchReminders(env: Env, db: DB, now: Date): Promise<void> {
  const due = await db
    .select()
    .from(reminder)
    .where(and(eq(reminder.status, "pending"), lte(reminder.remindAt, now)))
    .orderBy(asc(reminder.remindAt))
    .limit(REMINDER_LIMIT);

  await Promise.all(
    due.map(async (row) => {
      try {
        await db
          .update(reminder)
          .set({ status: "fired", firedAt: now, updatedAt: now })
          .where(eq(reminder.id, row.id));

        await broadcastToUsers(env, [row.userId], {
          type: "reminder_fired",
          reminderId: row.id,
          mailboxId: row.mailboxId,
          threadId: row.threadId,
          subject: row.subject,
          note: row.note ?? undefined,
        });

        await pushToUsers(db, [row.userId], {
          title: row.kind === "follow_up" ? "No reply yet" : "Reminder",
          body: row.subject || "(no subject)",
          url: `/app/m/${row.mailboxId}/t/${row.threadId}`,
          threadId: row.threadId,
        });
      } catch (err) {
        console.error(`reminder dispatch failed for ${row.id}`, err);
      }
    }),
  );
}

// Dispatch drafts whose scheduled send time has arrived. Each is sent through
// the normal outbound path with its stored payload, then the draft is deleted.
// A send that throws is retried on later ticks; after a few failures the row is
// reverted to an editable draft, flagged with the error, and the author warned.
async function dispatchScheduledSends(env: Env, db: DB, now: Date): Promise<void> {
  const due = await db
    .select()
    .from(draft)
    .where(and(isNotNull(draft.scheduledFor), lte(draft.scheduledFor, now)))
    .orderBy(asc(draft.scheduledFor))
    .limit(SCHEDULED_SEND_LIMIT);

  await Promise.all(
    due.map(async (row) => {
      const payload = row.scheduledPayload;
      // A scheduled row without a payload is corrupt — unschedule it rather than
      // loop on it every tick.
      if (!payload) {
        await db.update(draft).set({ scheduledFor: null }).where(eq(draft.id, row.id));
        return;
      }
      try {
        const quote = payload.quote
          ? await buildQuote(env, db, row.userId, payload.quote)
          : undefined;
        await sendFromMailbox(env, db, row.userId, payload, quote);

        // The send consumed the temp upload blobs (they live in the new .eml);
        // drop them and the draft, mirroring the post-send cleanup of the UI.
        const prefix = `draft/${row.userId}/`;
        await Promise.all(
          (payload.attachments ?? [])
            .filter((a) => a.r2Key.startsWith(prefix))
            .map((a) => env.BLOBS.delete(a.r2Key)),
        );
        await db.delete(draft).where(eq(draft.id, row.id));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const attempts = row.scheduledAttempts + 1;
        console.error(
          `scheduled send failed for draft ${row.id} (attempt ${attempts}/${SCHEDULED_SEND_MAX_ATTEMPTS})`,
          err,
        );
        if (attempts < SCHEDULED_SEND_MAX_ATTEMPTS) {
          // Bump the counter but leave `scheduledFor` in the past so the next
          // tick retries it.
          await db.update(draft).set({ scheduledAttempts: attempts }).where(eq(draft.id, row.id));
          return;
        }
        // Out of retries — revert to an editable draft, flag the failure, warn.
        await db
          .update(draft)
          .set({
            scheduledFor: null,
            scheduledPayload: null,
            scheduledAttempts: attempts,
            scheduledError: detail,
            updatedAt: now,
          })
          .where(eq(draft.id, row.id));
        await broadcastToUsers(env, [row.userId], {
          type: "scheduled_send_failed",
          mailboxId: row.mailboxId,
          draftId: row.id,
          error: detail,
        });
      }
    }),
  );
}
