import { draft } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { createDraft, scheduleDraft, updateDraft } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { assertOwnedAttachmentKeys } from "../mail/attachment-keys.ts";
import { requireUser } from "../middleware.ts";
import { ALL_MAILBOXES, requirePerm } from "../permissions.ts";
import { cursorBefore, decodeCursor, nextCursor } from "./pagination.ts";
import { serializeDraft } from "./serialize.ts";
import { buildPatch } from "./util.ts";

export function draftsRoutes() {
  const r = new Hono<AppBindings>()
    .use("*", requireUser)

    // List the current user's drafts in a mailbox (drafts are per-author).
    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const mailboxId = c.req.query("mailboxId");
      if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });

      // "All" view: every draft the user authored, regardless of mailbox. Drafts
      // are already scoped to the author, so no per-mailbox permission check.
      let scope: ReturnType<typeof eq> | ReturnType<typeof and>;
      if (mailboxId === ALL_MAILBOXES) {
        scope = eq(draft.userId, user.id);
      } else {
        await requirePerm(db, user.id, mailboxId, Perm.READ);
        scope = and(eq(draft.mailboxId, mailboxId), eq(draft.userId, user.id));
      }

      const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
      const cursor = decodeCursor(c.req.query("cursor"));
      const rows = await db
        .select()
        .from(draft)
        .where(and(scope, cursorBefore(cursor, draft.updatedAt, draft.id)))
        .orderBy(desc(draft.updatedAt), desc(draft.id))
        .limit(limit);
      return c.json({
        drafts: rows.map(serializeDraft),
        nextCursor: nextCursor(rows, limit, (d) => ({ ts: d.updatedAt, id: d.id })),
      });
    })

    .get("/:id", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const row = await loadOwn(db, c.req.param("id"), user.id);
      return c.json({ draft: serializeDraft(row) });
    })

    .post("/", zValidator("json", createDraft), async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const body = c.req.valid("json");
      await requirePerm(db, user.id, body.mailboxId, Perm.WRITE);
      assertOwnedAttachmentKeys(user.id, body.attachments);

      const id = crypto.randomUUID();
      const [row] = await db
        .insert(draft)
        .values({
          id,
          mailboxId: body.mailboxId,
          userId: user.id,
          fromAddress: body.fromAddress ?? null,
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
        })
        .returning();
      if (!row) throw new HTTPException(500, { message: "draft not found after insert" });
      return c.json({ draft: serializeDraft(row) }, 201);
    })

    .patch("/:id", zValidator("json", updateDraft), async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");
      await loadOwn(db, id, user.id);
      if (body.attachments !== undefined) assertOwnedAttachmentKeys(user.id, body.attachments);

      const patch = buildPatch<typeof draft.$inferInsert>(body, {
        fromAddress: true,
        to: { to: "toAddrs" },
        cc: { to: "ccAddrs" },
        bcc: { to: "bccAddrs" },
        subject: true,
        body: true,
        inReplyTo: true,
        references: true,
        attachments: true,
      });
      patch.updatedAt = new Date();
      // format drives the `markdown` flag; quote fans out to two columns — both
      // are one-to-many so they stay out of the field map.
      if (body.format !== undefined) {
        patch.format = body.format;
        patch.markdown = body.format === "markdown";
      }
      if (body.quote !== undefined) {
        patch.quoteMessageId = body.quote?.messageId ?? null;
        patch.quoteKind = body.quote?.kind ?? null;
      }

      const [row] = await db.update(draft).set(patch).where(eq(draft.id, id)).returning();
      if (!row) throw new HTTPException(404, { message: "not found" });
      return c.json({ draft: serializeDraft(row) });
    })

    // Defer this draft's send to `sendAt`. The draft itself is the scheduled
    // record (so it stays visible/cancelable in the Drafts list); the cron replays
    // the stored payload at the chosen time and deletes the draft. WRITE on the
    // mailbox is the same bar as an immediate send.
    .post("/:id/schedule", zValidator("json", scheduleDraft), async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      const { sendAt, payload } = c.req.valid("json");
      const row = await loadOwn(db, id, user.id);
      await requirePerm(db, user.id, row.mailboxId, Perm.WRITE);
      assertOwnedAttachmentKeys(user.id, payload.attachments);

      const [updated] = await db
        .update(draft)
        .set({
          scheduledFor: new Date(sendAt),
          // Pin the payload's mailbox to the draft's own — never let a body sneak
          // a send out of a mailbox the caller didn't pass the WRITE check for.
          scheduledPayload: { ...payload, mailboxId: row.mailboxId },
          scheduledAttempts: 0,
          scheduledError: null,
          updatedAt: new Date(),
        })
        .where(eq(draft.id, id))
        .returning();
      if (!updated) throw new HTTPException(404, { message: "not found" });
      return c.json({ draft: serializeDraft(updated) });
    })

    // Cancel a scheduled send (or clear a failed one) — the row reverts to an
    // ordinary editable draft.
    .delete("/:id/schedule", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      await loadOwn(db, id, user.id);
      const [updated] = await db
        .update(draft)
        .set({
          scheduledFor: null,
          scheduledPayload: null,
          scheduledAttempts: 0,
          scheduledError: null,
          updatedAt: new Date(),
        })
        .where(eq(draft.id, id))
        .returning();
      if (!updated) throw new HTTPException(404, { message: "not found" });
      return c.json({ draft: serializeDraft(updated) });
    })

    .delete("/:id", async (c) => {
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
