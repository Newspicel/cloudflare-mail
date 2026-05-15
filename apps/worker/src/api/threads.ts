import { message, thread } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { updateThread } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
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
    const view = (c.req.query("view") ?? "inbox") as "inbox" | "archive" | "trash";
    const filter =
      view === "trash"
        ? eq(thread.trashed, true)
        : view === "archive"
          ? and(eq(thread.archived, true), eq(thread.trashed, false))
          : and(eq(thread.archived, false), eq(thread.trashed, false));

    const rows = await db
      .select()
      .from(thread)
      .where(and(eq(thread.mailboxId, mailboxId), filter))
      .orderBy(desc(thread.lastMsgAt))
      .limit(limit);
    return c.json({ threads: rows });
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
      columns: { mailboxId: true, archived: true, trashed: true },
    });
    if (!th) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, th.mailboxId, Perm.WRITE);

    const patch: Partial<{ archived: boolean; trashed: boolean }> = {};
    if (body.archived !== undefined) patch.archived = body.archived;
    if (body.trashed !== undefined) {
      patch.trashed = body.trashed;
      // Trashing implies un-archiving so the row only appears in one bucket.
      if (body.trashed && body.archived === undefined) patch.archived = false;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ archived: th.archived, trashed: th.trashed });
    }
    await db.update(thread).set(patch).where(eq(thread.id, id));
    return c.json({
      archived: patch.archived ?? th.archived,
      trashed: patch.trashed ?? th.trashed,
    });
  });

  return r;
}
