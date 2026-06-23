import { draft } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { createDraft, updateDraft } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { assertOwnedAttachmentKeys } from "../mail/attachment-keys.ts";
import { requireUser } from "../middleware.ts";
import { ALL_MAILBOXES, requirePerm } from "../permissions.ts";
import { serializeDraft } from "./serialize.ts";

export function draftsRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  // List the current user's drafts in a mailbox (drafts are per-author).
  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const mailboxId = c.req.query("mailboxId");
    if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });

    // "All" view: every draft the user authored, regardless of mailbox. Drafts
    // are already scoped to the author, so no per-mailbox permission check.
    let where: ReturnType<typeof eq> | ReturnType<typeof and>;
    if (mailboxId === ALL_MAILBOXES) {
      where = eq(draft.userId, user.id);
    } else {
      await requirePerm(db, user.id, mailboxId, Perm.READ);
      where = and(eq(draft.mailboxId, mailboxId), eq(draft.userId, user.id));
    }

    const rows = await db.select().from(draft).where(where).orderBy(desc(draft.updatedAt));
    return c.json({ drafts: rows.map(serializeDraft) });
  });

  r.get("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const row = await loadOwn(db, c.req.param("id"), user.id);
    return c.json({ draft: serializeDraft(row) });
  });

  r.post("/", zValidator("json", createDraft), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");
    await requirePerm(db, user.id, body.mailboxId, Perm.WRITE);
    assertOwnedAttachmentKeys(user.id, body.attachments);

    const id = crypto.randomUUID();
    await db.insert(draft).values({
      id,
      mailboxId: body.mailboxId,
      userId: user.id,
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? null,
      quoteMessageId: body.quote?.messageId ?? null,
      quoteKind: body.quote?.kind ?? null,
      toAddrs: body.to,
      ccAddrs: body.cc ?? null,
      bccAddrs: body.bcc ?? null,
      subject: body.subject,
      body: body.body,
      format: body.format,
      markdown: body.format === "markdown",
      attachments: body.attachments,
    });
    const row = await db.query.draft.findFirst({ where: eq(draft.id, id) });
    if (!row) throw new HTTPException(500, { message: "draft not found after insert" });
    return c.json({ draft: serializeDraft(row) }, 201);
  });

  r.patch("/:id", zValidator("json", updateDraft), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await loadOwn(db, id, user.id);
    if (body.attachments !== undefined) assertOwnedAttachmentKeys(user.id, body.attachments);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.to !== undefined) patch.toAddrs = body.to;
    if (body.cc !== undefined) patch.ccAddrs = body.cc;
    if (body.bcc !== undefined) patch.bccAddrs = body.bcc;
    if (body.subject !== undefined) patch.subject = body.subject;
    if (body.body !== undefined) patch.body = body.body;
    if (body.format !== undefined) {
      patch.format = body.format;
      patch.markdown = body.format === "markdown";
    }
    if (body.inReplyTo !== undefined) patch.inReplyTo = body.inReplyTo;
    if (body.references !== undefined) patch.references = body.references;
    if (body.quote !== undefined) {
      patch.quoteMessageId = body.quote?.messageId ?? null;
      patch.quoteKind = body.quote?.kind ?? null;
    }
    if (body.attachments !== undefined) patch.attachments = body.attachments;

    await db.update(draft).set(patch).where(eq(draft.id, id));
    const row = await db.query.draft.findFirst({ where: eq(draft.id, id) });
    if (!row) throw new HTTPException(404, { message: "not found" });
    return c.json({ draft: serializeDraft(row) });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const row = await loadOwn(db, id, user.id);

    // Best-effort cleanup of orphaned draft attachment blobs in R2. Only touch
    // keys in the caller's own upload namespace — never delete other tenants'
    // blobs, even if a stale row somehow holds a foreign key.
    const prefix = `draft/${user.id}/`;
    await Promise.all(
      (row.attachments ?? [])
        .filter((a) => a.r2Key.startsWith(prefix))
        .map((a) => c.env.BLOBS.delete(a.r2Key)),
    );
    await db.delete(draft).where(eq(draft.id, id));
    return c.json({ ok: true });
  });

  return r;
}

async function loadOwn(db: ReturnType<typeof dbFromCtx>, id: string, userId: string) {
  const row = await db.query.draft.findFirst({ where: eq(draft.id, id) });
  if (!row || row.userId !== userId) throw new HTTPException(404, { message: "not found" });
  return row;
}
