import { draft, message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { updateThread } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { recomputeThreadUnread } from "../mail/threads.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

export function threadsRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const mailboxId = c.req.query("mailboxId");
    if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });
    await requirePerm(db, user.id, mailboxId, Perm.READ);

    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const view = c.req.query("view") ?? "inbox";

    // Threads not in the trash/spam buckets — the basis for inbox/sent/marked.
    const active = and(eq(thread.trashed, false), eq(thread.spam, false));

    let filter: SQL | undefined;
    switch (view) {
      case "trash":
        filter = eq(thread.trashed, true);
        break;
      case "spam":
        filter = and(eq(thread.spam, true), eq(thread.trashed, false));
        break;
      case "all":
        filter = undefined;
        break;
      case "sent":
        filter = and(active, hasMessage(eq(message.direction, "out")));
        break;
      case "marked":
        filter = and(
          active,
          hasMessage(sql`(${message.flags} & ${Flag.STARRED}) = ${Flag.STARRED}`),
        );
        break;
      default:
        filter = and(active, hasMessage(eq(message.direction, "in")));
    }

    const rows = await db
      .select()
      .from(thread)
      .where(
        filter ? and(eq(thread.mailboxId, mailboxId), filter) : eq(thread.mailboxId, mailboxId),
      )
      .orderBy(desc(thread.lastMsgAt))
      .limit(limit);
    return c.json({ threads: rows });
  });

  // Per-folder badge counts for the icon bar. `unread` is only meaningful for
  // the inbox/spam buckets; the rest report totals.
  r.get("/counts", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const mailboxId = c.req.query("mailboxId");
    if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });
    await requirePerm(db, user.id, mailboxId, Perm.READ);

    const inMailbox = eq(thread.mailboxId, mailboxId);
    const active = and(inMailbox, eq(thread.trashed, false), eq(thread.spam, false));
    const inSpam = and(inMailbox, eq(thread.spam, true), eq(thread.trashed, false));
    const starred = sql`(${message.flags} & ${Flag.STARRED}) = ${Flag.STARRED}`;

    const cnt = async (cond: SQL | undefined): Promise<number> => {
      const rows = await db.select({ c: count() }).from(thread).where(cond);
      return rows[0]?.c ?? 0;
    };
    const draftCnt = async (): Promise<number> => {
      const rows = await db
        .select({ c: count() })
        .from(draft)
        .where(and(eq(draft.mailboxId, mailboxId), eq(draft.userId, user.id)));
      return rows[0]?.c ?? 0;
    };

    const [inbox, inboxUnread, sent, marked, spam, spamUnread, trash, all, drafts] =
      await Promise.all([
        cnt(and(active, hasMessage(eq(message.direction, "in")))),
        cnt(and(active, hasMessage(eq(message.direction, "in")), gt(thread.unreadCount, 0))),
        cnt(and(active, hasMessage(eq(message.direction, "out")))),
        cnt(and(active, hasMessage(starred))),
        cnt(inSpam),
        cnt(and(inSpam, gt(thread.unreadCount, 0))),
        cnt(and(inMailbox, eq(thread.trashed, true))),
        cnt(inMailbox),
        draftCnt(),
      ]);

    return c.json({
      counts: {
        inbox: { total: inbox, unread: inboxUnread },
        drafts: { total: drafts, unread: 0 },
        sent: { total: sent, unread: 0 },
        marked: { total: marked, unread: 0 },
        spam: { total: spam, unread: spamUnread },
        trash: { total: trash, unread: 0 },
        all: { total: all, unread: 0 },
      },
    });
  });

  r.get("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");

    const th = await db.query.thread.findFirst({ where: eq(thread.id, id) });
    if (!th) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, th.mailboxId, Perm.READ);

    const msgs = await db
      .select()
      .from(message)
      .where(and(eq(message.threadId, id), eq(message.mailboxId, th.mailboxId)))
      .orderBy(asc(message.createdAt));

    return c.json({ thread: th, messages: msgs });
  });

  r.patch("/:id", zValidator("json", updateThread), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const th = await db.query.thread.findFirst({
      where: eq(thread.id, id),
      columns: { mailboxId: true, trashed: true, spam: true, unreadCount: true },
    });
    if (!th) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, th.mailboxId, Perm.WRITE);

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
    }

    return c.json({
      trashed: patch.trashed ?? th.trashed,
      spam: patch.spam ?? th.spam,
      unreadCount,
    });
  });

  return r;
}

// Correlated EXISTS over a thread's messages (sent/starred live on rows, not
// the thread) — lets the sent/marked folders filter by message-level state.
function hasMessage(cond: SQL): SQL {
  return sql`exists (select 1 from ${message} where ${message.threadId} = ${thread.id} and ${cond})`;
}
