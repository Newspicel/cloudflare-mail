import { contactKey, draft, message, thread, threadFolder, threadSummary } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import type { FolderCountsResponseDto, ThreadSummaryDto } from "@cfmail/shared/responses";
import { updateThread } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, inArray, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { generateThreadSummary } from "../mail/ai.ts";
import { collectThreadBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { recomputeThreadUnread } from "../mail/threads.ts";
import { requireUser } from "../middleware.ts";
import {
  ALL_MAILBOXES,
  accessibleMailboxIds,
  requireEntityAccess,
  requirePerm,
} from "../permissions.ts";
import { cursorBefore, decodeCursor, nextCursor } from "./pagination.ts";
import { serializeMessage, serializeThread } from "./serialize.ts";

export function threadsRoutes() {
  const r = new Hono<AppBindings>()
    .use("*", requireUser)

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const mailboxId = c.req.query("mailboxId");
      if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });

      // The combined "All" view spans every mailbox the user can read; a normal
      // request is scoped (and permission-checked) to a single mailbox.
      let scope: SQL;
      if (mailboxId === ALL_MAILBOXES) {
        const ids = await accessibleMailboxIds(db, user.id);
        if (ids.length === 0) return c.json({ threads: [] });
        scope = inArray(thread.mailboxId, ids);
      } else {
        const access = await requirePerm(db, user.id, mailboxId, Perm.READ);
        // Being emptied in the background: its threads are already on their way out.
        if (access.purging) return c.json({ threads: [] });
        scope = eq(thread.mailboxId, mailboxId);
      }

      const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
      const view = c.req.query("view") ?? "inbox";
      const cursor = decodeCursor(c.req.query("cursor"));

      // Threads not in trash/spam and not filed into a custom folder by this user
      // — the basis for the active inbox/sent/marked views (filed = "moved away").
      const active = and(eq(thread.trashed, false), eq(thread.spam, false), notFiledBy(user.id));

      let filter: SQL | undefined;
      switch (view) {
        case "trash":
          // Whole-thread trash, plus live threads holding an individually-deleted
          // message (those surface in Trash for just that message).
          filter = trashFilter;
          break;
        case "spam":
          filter = and(eq(thread.spam, true), eq(thread.trashed, false));
          break;
        case "all":
          filter = undefined;
          break;
        case "sent":
          filter = and(active, hasMessage(and(eq(message.direction, "out"), LIVE_MSG)));
          break;
        case "marked":
          filter = and(active, hasMessage(and(STARRED_MSG, LIVE_MSG)));
          break;
        default:
          filter = and(active, hasMessage(and(eq(message.direction, "in"), LIVE_MSG)));
      }

      const where = and(scope, filter, cursorBefore(cursor, thread.lastMsgAt, thread.id));
      const rows = await db
        .select()
        .from(thread)
        .where(where)
        // Keyset order must be deterministic: tie-break equal timestamps on id so
        // the cursor never straddles or repeats a row across pages.
        .orderBy(desc(thread.lastMsgAt), desc(thread.id))
        .limit(limit);
      return c.json({
        threads: rows.map(serializeThread),
        nextCursor: nextCursor(rows, limit, (row) => ({ ts: row.lastMsgAt, id: row.id })),
      });
    })

    // Per-folder badge counts for the icon bar. `unread` is only meaningful for
    // the inbox/spam buckets; the rest report totals.
    .get("/counts", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const mailboxId = c.req.query("mailboxId");
      if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });

      const isAll = mailboxId === ALL_MAILBOXES;
      let inMailbox: SQL;
      if (isAll) {
        const ids = await accessibleMailboxIds(db, user.id);
        if (ids.length === 0)
          return c.json({ counts: emptyCounts() } satisfies FolderCountsResponseDto);
        inMailbox = inArray(thread.mailboxId, ids);
      } else {
        const access = await requirePerm(db, user.id, mailboxId, Perm.READ);
        if (access.purging)
          return c.json({ counts: emptyCounts() } satisfies FolderCountsResponseDto);
        inMailbox = eq(thread.mailboxId, mailboxId);
      }

      const active = and(
        inMailbox,
        eq(thread.trashed, false),
        eq(thread.spam, false),
        notFiledBy(user.id),
      );
      const inSpam = and(inMailbox, eq(thread.spam, true), eq(thread.trashed, false));

      // Every folder badge is a count over the same `thread` rows, so fold them
      // into one scan with conditional sums instead of nine separate COUNT(*)
      // round-trips. Each correlated EXISTS is evaluated once per row in that pass.
      const unread = gt(thread.unreadCount, 0);
      const inLive = hasMessage(and(eq(message.direction, "in"), LIVE_MSG));
      const aggP = db
        .select({
          inbox: sumIf(and(active, inLive)!),
          inboxUnread: sumIf(and(active, inLive, unread)!),
          sent: sumIf(and(active, hasMessage(and(eq(message.direction, "out"), LIVE_MSG)))!),
          marked: sumIf(and(active, hasMessage(and(STARRED_MSG, LIVE_MSG)))!),
          spam: sumIf(inSpam!),
          spamUnread: sumIf(and(inSpam, unread)!),
          trash: sumIf(trashFilter!),
          all: count(),
        })
        .from(thread)
        .where(inMailbox);
      // Drafts are per-author and live in their own table; the "All" view counts
      // the user's drafts across every mailbox, otherwise just the one.
      const draftWhere = isAll
        ? eq(draft.userId, user.id)
        : and(eq(draft.mailboxId, mailboxId), eq(draft.userId, user.id));
      const draftP = db.select({ c: count() }).from(draft).where(draftWhere);

      const [[agg], draftRows] = await Promise.all([aggP, draftP]);

      return c.json({
        counts: {
          inbox: { total: n(agg?.inbox), unread: n(agg?.inboxUnread) },
          drafts: { total: draftRows[0]?.c ?? 0, unread: 0 },
          sent: { total: n(agg?.sent), unread: 0 },
          marked: { total: n(agg?.marked), unread: 0 },
          spam: { total: n(agg?.spam), unread: n(agg?.spamUnread) },
          trash: { total: n(agg?.trash), unread: 0 },
          all: { total: n(agg?.all), unread: 0 },
        },
      } satisfies FolderCountsResponseDto);
    })

    .get("/:id", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");

      const th = await requireEntityAccess(db, user.id, thread, id, Perm.READ);

      const msgs = await db
        .select()
        .from(message)
        .where(and(eq(message.threadId, id), eq(message.mailboxId, th.mailboxId)))
        .orderBy(asc(message.createdAt));

      // Attach the stored correspondent key for each inbound sender so the reader
      // can show which key verified a signature and its trust state. One batched
      // lookup keyed by lowercased From address.
      const senders = [
        ...new Set(
          msgs
            .filter((m) => m.direction === "in" && (m.pgpSigned || m.pgpEncrypted))
            .map((m) => m.fromAddr.toLowerCase()),
        ),
      ];
      const keyRows = senders.length
        ? await db.query.contactKey.findMany({
            where: and(eq(contactKey.mailboxId, th.mailboxId), inArray(contactKey.email, senders)),
            columns: { email: true, fingerprint: true, source: true, verified: true },
          })
        : [];
      const keyByEmail = new Map(keyRows.map((k) => [k.email, k]));

      return c.json({
        thread: serializeThread(th),
        messages: msgs.map((m) => {
          const k = m.direction === "in" ? keyByEmail.get(m.fromAddr.toLowerCase()) : undefined;
          return serializeMessage(
            m,
            k ? { fingerprint: k.fingerprint, source: k.source, verified: k.verified } : null,
          );
        }),
      });
    })

    // AI catch-up summary of a whole thread (best-effort, on-demand). READ only —
    // it just condenses messages the caller can already see.
    .post("/:id/summary", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      const th = await requireEntityAccess(db, user.id, thread, id, Perm.READ);

      const mb = await db.query.mailbox.findFirst({
        where: (m) => eq(m.id, th.mailboxId),
        columns: { aiFeatures: true, aiTokenCap: true },
      });
      if (!mb?.aiFeatures) throw new HTTPException(403, { message: "AI features are off" });

      // Reuse a cached summary while the thread is unchanged. `msgCount` moves on
      // any add/remove, so a stale cache is simply ignored and regenerated.
      const cached = await db.query.threadSummary.findFirst({
        where: (s) => eq(s.threadId, id),
      });
      if (cached && cached.msgCount === th.msgCount) {
        return c.json({ bullets: cached.bullets } satisfies ThreadSummaryDto);
      }

      // Cap how many messages feed the model so a long thread can't blow the
      // budget; keep the most recent ones, oldest-first for chronological context.
      const msgs = await db
        .select({
          fromName: message.fromName,
          fromAddr: message.fromAddr,
          subject: message.subject,
          bodyText: message.bodyText,
        })
        .from(message)
        .where(and(eq(message.threadId, id), eq(message.mailboxId, th.mailboxId)))
        .orderBy(desc(message.createdAt))
        .limit(20);
      msgs.reverse();

      const bullets = await generateThreadSummary(
        c.env,
        db,
        th.mailboxId,
        mb.aiTokenCap ?? null,
        msgs.map((m) => ({
          from: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr,
          subject: m.subject,
          body: m.bodyText ?? "",
        })),
      );
      // Only cache a real result — an empty list means generation failed or the
      // budget was exhausted, so leave it uncached to retry next time.
      if (bullets.length > 0) {
        await db
          .insert(threadSummary)
          .values({ threadId: id, bullets, msgCount: th.msgCount, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: threadSummary.threadId,
            set: { bullets, msgCount: th.msgCount, updatedAt: new Date() },
          });
      }
      return c.json({ bullets } satisfies ThreadSummaryDto);
    })

    .patch("/:id", zValidator("json", updateThread), async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");

      const th = await requireEntityAccess(db, user.id, thread, id, Perm.WRITE);

      // Trash and spam are mutually exclusive buckets: entering one clears the
      // other so a thread only ever shows up in a single folder.
      const patch: Partial<{ trashed: boolean; trashedAt: Date | null; spam: boolean }> = {};
      if (body.trashed !== undefined) {
        patch.trashed = body.trashed;
        patch.trashedAt = body.trashed ? new Date() : null;
        if (body.trashed && body.spam === undefined) patch.spam = false;
      }
      if (body.spam !== undefined) {
        patch.spam = body.spam;
        if (body.spam && body.trashed === undefined) patch.trashed = false;
      }
      if (Object.keys(patch).length > 0) {
        await db.update(thread).set(patch).where(eq(thread.id, id));
      }

      // Read/unread lives on message SEEN flags; flip every inbound message, then
      // reconcile the thread's cached unreadCount.
      let unreadCount = th.unreadCount;
      if (body.read !== undefined) {
        const seenBit = sql`${message.flags} | ${Flag.SEEN}`;
        const clearBit = sql`${message.flags} & ${~Flag.SEEN}`;
        await db
          .update(message)
          .set({ flags: body.read ? seenBit : clearBit })
          .where(and(eq(message.threadId, id), eq(message.direction, "in")));
        unreadCount = await recomputeThreadUnread(db, id);
        // Sync the reader's other devices: update their unread badge and dismiss
        // the thread's push notification once it's been read somewhere.
        await broadcastToUsers(c.env, [user.id], {
          type: "thread_read",
          mailboxId: th.mailboxId,
          threadId: id,
          read: body.read,
        });
      }

      return c.json({
        trashed: patch.trashed ?? th.trashed,
        spam: patch.spam ?? th.spam,
        unreadCount,
      });
    })

    // Permanent delete: drop the thread for good (used by the Trash folder).
    // Deleting the row cascades to messages/attachments via FKs; R2 blobs have no
    // cascade, so collect and delete them first.
    .delete("/:id", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");

      await requireEntityAccess(db, user.id, thread, id, Perm.WRITE);

      const keys = await collectThreadBlobKeys(db, [id]);
      await deleteBlobs(c.env, keys);
      await db.delete(thread).where(eq(thread.id, id));

      return c.json({ deleted: true });
    });

  return r;
}

function emptyCounts(): FolderCountsResponseDto["counts"] {
  const zero = { total: 0, unread: 0 };
  return {
    inbox: zero,
    drafts: zero,
    sent: zero,
    marked: zero,
    spam: zero,
    trash: zero,
    all: zero,
  };
}

// Correlated EXISTS over a thread's messages (sent/starred live on rows, not
// the thread) — lets the sent/marked folders filter by message-level state.
function hasMessage(cond: SQL | undefined): SQL {
  return sql`exists (select 1 from ${message} where ${message.threadId} = ${thread.id}${cond ? sql` and ${cond}` : sql``})`;
}

// Conditional count for a single-scan badge aggregate, plus a guard coercing a
// nullable SUM (no matching rows → null) to a number.
const sumIf = (cond: SQL) => sql<number>`sum(case when ${cond} then 1 else 0 end)`;
const n = (v: number | null | undefined): number => Number(v ?? 0);

// Message-level flag predicates. LIVE excludes individually-trashed messages so
// the active folders ignore them; TRASHED surfaces a thread in the Trash view.
const LIVE_MSG = sql`(${message.flags} & ${Flag.TRASH}) = 0`;
const TRASHED_MSG = sql`(${message.flags} & ${Flag.TRASH}) = ${Flag.TRASH}`;
const STARRED_MSG = sql`(${message.flags} & ${Flag.STARRED}) = ${Flag.STARRED}`;

// Trash view: a whole-thread trash, or an otherwise-active thread that holds at
// least one individually-deleted message (shown in Trash for just that message).
const trashFilter = or(
  eq(thread.trashed, true),
  and(eq(thread.trashed, false), eq(thread.spam, false), hasMessage(TRASHED_MSG)),
);

// True when the user has NOT filed this thread into a custom folder — filed
// threads are hidden from the active mailbox views (a true "move").
function notFiledBy(userId: string): SQL {
  return sql`not exists (select 1 from ${threadFolder} where ${threadFolder.threadId} = ${thread.id} and ${threadFolder.userId} = ${userId})`;
}
