import { message, thread } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
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
    const rows = await db
      .select()
      .from(thread)
      .where(eq(thread.mailboxId, mailboxId))
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

  return r;
}
