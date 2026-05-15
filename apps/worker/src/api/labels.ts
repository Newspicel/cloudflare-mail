import { label, message, messageLabel } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { createLabel, updateLabel } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

export function labelsRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const mailboxId = c.req.query("mailboxId");
    if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });
    await requirePerm(db, user.id, mailboxId, Perm.READ);
    const rows = await db
      .select()
      .from(label)
      .where(eq(label.mailboxId, mailboxId))
      .orderBy(asc(label.name));
    return c.json({ labels: rows });
  });

  r.post("/", zValidator("json", createLabel), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");
    await requirePerm(db, user.id, body.mailboxId, Perm.WRITE);
    const id = crypto.randomUUID();
    try {
      await db.insert(label).values({
        id,
        mailboxId: body.mailboxId,
        name: body.name.trim(),
        color: body.color ?? "#64748b",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/UNIQUE/i.test(msg)) {
        throw new HTTPException(409, { message: "name already exists" });
      }
      throw err;
    }
    return c.json({ id }, 201);
  });

  r.patch("/:id", zValidator("json", updateLabel), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const lab = await db.query.label.findFirst({
      where: eq(label.id, id),
      columns: { mailboxId: true },
    });
    if (!lab) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, lab.mailboxId, Perm.WRITE);
    const patch: Partial<{ name: string; color: string }> = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.color !== undefined) patch.color = body.color;
    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    await db.update(label).set(patch).where(eq(label.id, id));
    return c.json({ ok: true });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const lab = await db.query.label.findFirst({
      where: eq(label.id, id),
      columns: { mailboxId: true },
    });
    if (!lab) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, lab.mailboxId, Perm.WRITE);
    await db.delete(label).where(eq(label.id, id));
    return c.body(null, 204);
  });

  // Apply/remove a label on a single message.
  r.put("/:id/messages/:messageId", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const messageId = c.req.param("messageId");
    const { mailboxId } = await loadLabelAndMessage(db, id, messageId);
    await requirePerm(db, user.id, mailboxId, Perm.WRITE);
    await db.insert(messageLabel).values({ messageId, labelId: id }).onConflictDoNothing();
    return c.json({ ok: true });
  });

  r.delete("/:id/messages/:messageId", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const messageId = c.req.param("messageId");
    const { mailboxId } = await loadLabelAndMessage(db, id, messageId);
    await requirePerm(db, user.id, mailboxId, Perm.WRITE);
    await db
      .delete(messageLabel)
      .where(and(eq(messageLabel.messageId, messageId), eq(messageLabel.labelId, id)));
    return c.body(null, 204);
  });

  // Resolve labels attached to a set of message ids the caller already has access to.
  r.get("/by-messages", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const ids = c.req.queries("id") ?? [];
    if (ids.length === 0) return c.json({ labels: {} });

    const rows = await db
      .select({
        messageId: messageLabel.messageId,
        labelId: messageLabel.labelId,
        name: label.name,
        color: label.color,
        mailboxId: label.mailboxId,
      })
      .from(messageLabel)
      .innerJoin(label, eq(label.id, messageLabel.labelId))
      .where(inArray(messageLabel.messageId, ids));

    const uniqueMailboxIds = [...new Set(rows.map((row) => row.mailboxId))];
    const accessEntries = await Promise.all(
      uniqueMailboxIds.map(async (mid) => {
        try {
          await requirePerm(db, user.id, mid, Perm.READ);
          return [mid, true] as const;
        } catch {
          return [mid, false] as const;
        }
      }),
    );
    const accessCache = new Map<string, boolean>(accessEntries);
    const out: Record<string, { id: string; name: string; color: string }[]> = {};
    for (const row of rows) {
      if (!accessCache.get(row.mailboxId)) continue;
      let list = out[row.messageId];
      if (!list) {
        list = [];
        out[row.messageId] = list;
      }
      list.push({ id: row.labelId, name: row.name, color: row.color });
    }
    return c.json({ labels: out });
  });

  return r;
}

async function loadLabelAndMessage(
  db: ReturnType<typeof dbFromCtx>,
  labelId: string,
  messageId: string,
): Promise<{ mailboxId: string }> {
  const lab = await db.query.label.findFirst({
    where: eq(label.id, labelId),
    columns: { mailboxId: true },
  });
  if (!lab) throw new HTTPException(404, { message: "label not found" });
  const msg = await db.query.message.findFirst({
    where: eq(message.id, messageId),
    columns: { mailboxId: true },
  });
  if (!msg) throw new HTTPException(404, { message: "message not found" });
  if (msg.mailboxId !== lab.mailboxId) {
    throw new HTTPException(400, { message: "label/message mailbox mismatch" });
  }
  return { mailboxId: msg.mailboxId };
}
