import { attachment, domain, mailbox, message, shareToken, thread } from "@cfmail/db/schema";
import { has, Perm } from "@cfmail/shared/permissions";
import { and, asc, desc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";

export function publicShareRoutes() {
  const r = new Hono<AppBindings>();

  r.use("/:token/*", resolveShareToken);
  r.use("/:token", resolveShareToken);

  r.get("/:token", async (c) => {
    const db = dbFromCtx(c);
    const mailboxId = c.get("shareMailboxId")!;

    const mb = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        expiresAt: mailbox.expiresAt,
        domainName: domain.name,
      })
      .from(mailbox)
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .where(eq(mailbox.id, mailboxId))
      .limit(1);
    const m = mb[0];
    if (!m) throw new HTTPException(404, { message: "mailbox missing" });

    const threads = await db
      .select()
      .from(thread)
      .where(eq(thread.mailboxId, mailboxId))
      .orderBy(desc(thread.lastMsgAt))
      .limit(200);

    return c.json({
      mailbox: {
        id: m.id,
        address: `${m.localPart}@${m.domainName}`,
        displayName: m.displayName,
        type: m.type,
        expiresAt: m.expiresAt,
      },
      threads,
    });
  });

  r.get("/:token/threads/:id", async (c) => {
    const db = dbFromCtx(c);
    const mailboxId = c.get("shareMailboxId")!;
    const id = c.req.param("id");

    const th = await db.query.thread.findFirst({
      where: and(eq(thread.id, id), eq(thread.mailboxId, mailboxId)),
    });
    if (!th) throw new HTTPException(404, { message: "not found" });

    const msgs = await db
      .select()
      .from(message)
      .where(and(eq(message.threadId, id), eq(message.mailboxId, mailboxId)))
      .orderBy(asc(message.createdAt));

    return c.json({ thread: th, messages: msgs });
  });

  r.get("/:token/attachments/:id", async (c) => {
    const db = dbFromCtx(c);
    const mailboxId = c.get("shareMailboxId")!;
    const id = c.req.param("id");

    const rows = await db
      .select({
        r2Key: attachment.r2Key,
        filename: attachment.filename,
        contentType: attachment.contentType,
        messageMailboxId: message.mailboxId,
      })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .where(eq(attachment.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.messageMailboxId !== mailboxId) {
      throw new HTTPException(404, { message: "not found" });
    }

    const obj = await c.env.BLOBS.get(row.r2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    return new Response(obj.body, {
      headers: {
        "content-type": row.contentType,
        "content-disposition": `attachment; filename="${row.filename.replace(/"/g, "_")}"`,
      },
    });
  });

  return r;
}

const resolveShareToken: MiddlewareHandler<AppBindings> = async (c, next) => {
  const db = dbFromCtx(c);
  const token = c.req.param("token");
  if (!token) throw new HTTPException(400, { message: "token required" });

  const row = await db.query.shareToken.findFirst({
    where: eq(shareToken.id, token),
    columns: { mailboxId: true, perms: true, expiresAt: true },
  });
  if (!row) throw new HTTPException(404, { message: "not found" });
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new HTTPException(410, { message: "expired" });
  }
  if (!has(row.perms, Perm.READ)) throw new HTTPException(403, { message: "forbidden" });

  c.set("shareMailboxId", row.mailboxId);
  return next();
};
