import { folder, thread, threadFolder } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import type { FolderDto, FolderListDto, ThreadListDto } from "@cfmail/shared/responses";
import { createFolder, fileThreads, updateFolder } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";
import { accessibleMailboxIds, requirePerm } from "../permissions.ts";
import { cursorBefore, decodeCursor, nextCursor } from "./pagination.ts";
import { serializeThread } from "./serialize.ts";
import { buildPatch, wrapUnique } from "./util.ts";

function serializeFolder(r: typeof folder.$inferSelect, total: number, unread: number): FolderDto {
  return { ...r, createdAt: r.createdAt.toISOString(), total, unread };
}

export function foldersRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  // List the user's folders with live thread counts (active threads only).
  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;

    const rows = await db
      .select()
      .from(folder)
      .where(eq(folder.userId, user.id))
      .orderBy(asc(folder.position), asc(folder.createdAt));

    const ids = await accessibleMailboxIds(db, user.id);
    const counts = ids.length
      ? await db
          .select({
            folderId: threadFolder.folderId,
            total: count(),
            unread: sql<number>`sum(case when ${thread.unreadCount} > 0 then 1 else 0 end)`,
          })
          .from(threadFolder)
          .innerJoin(thread, eq(thread.id, threadFolder.threadId))
          .where(
            and(
              eq(threadFolder.userId, user.id),
              inArray(thread.mailboxId, ids),
              eq(thread.trashed, false),
              eq(thread.spam, false),
            ),
          )
          .groupBy(threadFolder.folderId)
      : [];
    const byId = new Map(counts.map((x) => [x.folderId, x]));

    return c.json({
      folders: rows.map((f) =>
        serializeFolder(f, byId.get(f.id)?.total ?? 0, Number(byId.get(f.id)?.unread ?? 0)),
      ),
    } satisfies FolderListDto);
  });

  r.post("/", zValidator("json", createFolder), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");

    const max = await db
      .select({ m: sql<number>`coalesce(max(${folder.position}), -1)` })
      .from(folder)
      .where(eq(folder.userId, user.id));

    const id = crypto.randomUUID();
    await wrapUnique(
      () =>
        db.insert(folder).values({
          id,
          userId: user.id,
          name: body.name.trim(),
          color: body.color ?? "#64748b",
          position: (max[0]?.m ?? -1) + 1,
        }),
      "name already exists",
    );
    return c.json({ id }, 201);
  });

  r.patch("/:id", zValidator("json", updateFolder), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");
    await requireOwnFolder(db, user.id, c.req.param("id"));

    const patch = buildPatch<typeof folder.$inferInsert>(body, {
      name: (v: string) => v.trim(),
      color: true,
      position: true,
    });
    if (Object.keys(patch).length === 0) return c.json({ ok: true });

    await wrapUnique(
      () =>
        db
          .update(folder)
          .set(patch)
          .where(eq(folder.id, c.req.param("id"))),
      "name already exists",
    );
    return c.json({ ok: true });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    await requireOwnFolder(db, user.id, c.req.param("id"));
    // thread_folder rows cascade on the folder FK.
    await db.delete(folder).where(eq(folder.id, c.req.param("id")));
    return c.body(null, 204);
  });

  // Threads filed into this folder, across every mailbox the user can read.
  // Trashed/spam threads are hidden (they live in those buckets instead).
  r.get("/:id/threads", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    await requireOwnFolder(db, user.id, id);

    const ids = await accessibleMailboxIds(db, user.id);
    if (ids.length === 0) return c.json({ threads: [], nextCursor: null } satisfies ThreadListDto);

    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const cursor = decodeCursor(c.req.query("cursor"));
    const rows = await db
      .select()
      .from(thread)
      .innerJoin(threadFolder, eq(threadFolder.threadId, thread.id))
      .where(
        and(
          eq(threadFolder.folderId, id),
          eq(threadFolder.userId, user.id),
          inArray(thread.mailboxId, ids),
          eq(thread.trashed, false),
          eq(thread.spam, false),
          cursorBefore(cursor, thread.lastMsgAt, thread.id),
        ),
      )
      .orderBy(desc(thread.lastMsgAt), desc(thread.id))
      .limit(limit);

    return c.json({
      threads: rows.map((row) => serializeThread(row.thread)),
      nextCursor: nextCursor(rows, limit, (row) => ({
        ts: row.thread.lastMsgAt,
        id: row.thread.id,
      })),
    } satisfies ThreadListDto);
  });

  // File one or more threads into this folder (a "move": replaces any prior
  // folder for that thread, and the thread leaves the user's active views).
  r.post("/:id/threads", zValidator("json", fileThreads), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    await requireOwnFolder(db, user.id, id);

    const { threadIds } = c.req.valid("json");
    await Promise.all(
      threadIds.map(async (threadId) => {
        const th = await db.query.thread.findFirst({
          where: eq(thread.id, threadId),
          columns: { mailboxId: true },
        });
        if (!th) return;
        // Filing is personal organization; reading the thread is enough.
        await requirePerm(db, user.id, th.mailboxId, Perm.READ);
        await db
          .insert(threadFolder)
          .values({ userId: user.id, threadId, folderId: id, filedAt: new Date() })
          .onConflictDoUpdate({
            target: [threadFolder.userId, threadFolder.threadId],
            set: { folderId: id, filedAt: new Date() },
          });
      }),
    );
    return c.json({ ok: true });
  });

  // Remove a thread from the folder (move it back to its mailbox views).
  r.delete("/:id/threads/:threadId", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    await requireOwnFolder(db, user.id, id);

    await db
      .delete(threadFolder)
      .where(
        and(
          eq(threadFolder.userId, user.id),
          eq(threadFolder.threadId, c.req.param("threadId")),
          eq(threadFolder.folderId, id),
        ),
      );
    return c.body(null, 204);
  });

  return r;
}

async function requireOwnFolder(
  db: ReturnType<typeof dbFromCtx>,
  userId: string,
  folderId: string,
): Promise<void> {
  const f = await db.query.folder.findFirst({
    where: eq(folder.id, folderId),
    columns: { userId: true },
  });
  if (!f || f.userId !== userId) throw new HTTPException(404, { message: "not found" });
}
