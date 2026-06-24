import { attachment, blocklist, blockRequest, message, thread } from "@cfmail/db/schema";
import { Flag, setFlag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import type { MessageBodyDto, SmartReplyDto } from "@cfmail/shared/responses";
import { createBlockRequest, sendMessage } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getOrCreateAuthSecret } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { generateSmartReply } from "../mail/ai.ts";
import { assertOwnedAttachmentKeys } from "../mail/attachment-keys.ts";
import { collectMessageBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { extractCalendar } from "../mail/calendar.ts";
import {
  bareCid,
  MAX_IMAGE_BYTES,
  proxyRemoteContent,
  rewriteInlineCids,
  safeRedirectFetch,
  verifyProxyUrl,
} from "../mail/img-proxy.ts";
import { parseMime } from "../mail/mime.ts";
import { buildQuote } from "../mail/quote.ts";
import { sendFromMailbox } from "../mail/send.ts";
import { recomputeThreadAfterMessageDelete, recomputeThreadUnread } from "../mail/threads.ts";
import { performUnsubscribe } from "../mail/unsubscribe.ts";
import { requireUser } from "../middleware.ts";
import { requireEntityAccess, requirePerm } from "../permissions.ts";

// ASCII-safe, filesystem-safe stem for a downloaded `.eml` (Content-Disposition
// filename); collapses anything non-alphanumeric to a single dash.
function slugifyForFile(subject: string | null): string {
  return (subject ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const patchSchema = z.object({
  seen: z.boolean().optional(),
  starred: z.boolean().optional(),
  trash: z.boolean().optional(),
});

export function messagesRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.post("/send", zValidator("json", sendMessage), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");
    await requirePerm(db, user.id, body.mailboxId, Perm.WRITE);
    assertOwnedAttachmentKeys(user.id, body.attachments);
    // Reply/forward quoting is resolved server-side from the original raw `.eml`
    // so the quoted body keeps its real (un-proxied) image URLs for the recipient.
    const quote = body.quote ? await buildQuote(c.env, db, user.id, body.quote) : undefined;
    const result = await sendFromMailbox(c.env, db, user.id, body, quote);
    return c.json(result, 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const patch = c.req.valid("json");

    // Trashing hides mail thread-wide, so it needs WRITE (matches thread-level trash);
    // seen/starred are per-reader state and only need READ.
    const msg = await requireEntityAccess(
      db,
      user.id,
      message,
      id,
      patch.trash !== undefined ? Perm.WRITE : Perm.READ,
    );

    let flags = msg.flags;
    if (patch.seen !== undefined) flags = setFlag(flags, Flag.SEEN, patch.seen);
    if (patch.starred !== undefined) flags = setFlag(flags, Flag.STARRED, patch.starred);
    if (patch.trash !== undefined) flags = setFlag(flags, Flag.TRASH, patch.trash);

    await db.update(message).set({ flags }).where(eq(message.id, id));
    // SEEN drives the thread's unread badge, and a trashed message drops out of
    // the count — keep the cached total in sync after either changes.
    if (patch.seen !== undefined || patch.trash !== undefined) {
      const unread = await recomputeThreadUnread(db, msg.threadId);
      // Mirror the read state to the reader's other devices (badge sync +
      // notification dismissal) when this clears/sets the thread's last unread.
      if (patch.seen !== undefined)
        await broadcastToUsers(c.env, [user.id], {
          type: "thread_read",
          mailboxId: msg.mailboxId,
          threadId: msg.threadId,
          read: unread === 0,
        });
    }
    return c.json({ flags });
  });

  // Permanently drop a single message out of its thread (irreversible). Deleting
  // the row cascades to its attachments via FKs; R2 blobs don't cascade, so
  // collect and delete them first. When it's the thread's last message the whole
  // (now-empty) thread goes too; otherwise the thread's cached aggregates are
  // reconciled with the survivors.
  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");

    // Deleting hides mail thread-wide and can't be undone — gate on WRITE.
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.WRITE);

    const keys = await collectMessageBlobKeys(db, id);
    await deleteBlobs(c.env, keys);

    const rows = await db
      .select({ c: count() })
      .from(message)
      .where(eq(message.threadId, msg.threadId));
    const remaining = (rows[0]?.c ?? 1) - 1;

    await db.delete(message).where(eq(message.id, id));

    if (remaining <= 0) {
      await db.delete(thread).where(eq(thread.id, msg.threadId));
      return c.json({ deleted: true, threadDeleted: true });
    }

    await recomputeThreadAfterMessageDelete(db, msg.threadId);
    return c.json({ deleted: true, threadDeleted: false });
  });

  // Act on the message's List-Unsubscribe headers (newsletter opt-out). May POST
  // a one-click request, send a mailto, or hand back an https link to open.
  r.post("/:id/unsubscribe", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    // Unsubscribing acts outward on the sender's behalf (sends mail / hits their
    // endpoint), so it needs WRITE — the same bar as sending from the mailbox.
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.WRITE);
    if (msg.direction !== "in") throw new HTTPException(400, { message: "not an inbound message" });
    return c.json(await performUnsubscribe(c.env, db, msg));
  });

  // Submit a request to block this message's sender. The deployment-wide
  // blocklist is admin-managed (invariant: hard blocks reject inbound at intake),
  // so a reader can only *request* a block; an admin approves it. READ is enough
  // — requesting is harmless until reviewed.
  r.post("/:id/block-request", zValidator("json", createBlockRequest), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.READ);
    if (msg.direction !== "in") throw new HTTPException(400, { message: "not an inbound message" });

    const value = msg.fromAddr.trim().toLowerCase();
    if (!value.includes("@")) throw new HTTPException(400, { message: "no sender address" });

    // No-op if the sender is already blocked, or this reader already has a
    // pending request for them — keep the queue free of duplicates.
    const already = await db.query.blocklist.findFirst({
      where: and(eq(blocklist.type, "email"), eq(blocklist.value, value)),
      columns: { id: true },
    });
    if (already) return c.json({ status: "already-blocked" });
    const pending = await db.query.blockRequest.findFirst({
      where: and(
        eq(blockRequest.requestedByUserId, user.id),
        eq(blockRequest.value, value),
        eq(blockRequest.status, "pending"),
      ),
      columns: { id: true },
    });
    if (pending) return c.json({ status: "pending" });

    await db.insert(blockRequest).values({
      id: crypto.randomUUID(),
      type: "email",
      value,
      fromName: msg.fromName ?? null,
      subject: msg.subject || null,
      note: body.note?.trim() || null,
      messageId: msg.id,
      mailboxId: msg.mailboxId,
      requestedByUserId: user.id,
    });
    return c.json({ status: "submitted" }, 201);
  });

  // AI-drafted reply suggestions for an inbound message (best-effort, on-demand).
  // READ is enough — it only returns text the user may choose to send.
  r.post("/:id/smart-reply", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.READ);
    if (msg.direction !== "in") throw new HTTPException(400, { message: "not an inbound message" });

    const mb = await db.query.mailbox.findFirst({
      where: (m) => eq(m.id, msg.mailboxId),
      columns: { aiFeatures: true, aiTokenCap: true },
    });
    if (!mb?.aiFeatures) throw new HTTPException(403, { message: "AI features are off" });

    const suggestions = await generateSmartReply(c.env, db, msg.mailboxId, mb.aiTokenCap ?? null, {
      from: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
      subject: msg.subject,
      body: msg.bodyText ?? "",
    });
    return c.json({ suggestions } satisfies SmartReplyDto);
  });

  // Full body, parsed on demand from the raw `.eml`. Listing endpoints only
  // carry the snippet; this is fetched lazily when a message is opened.
  r.get("/:id/body", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.READ);
    // For decrypted inbound mail the plaintext lives at plainR2Key; the original
    // ciphertext stays at rawR2Key (served by /:id/raw). Prefer plaintext here.
    const bodyKey = msg.plainR2Key ?? msg.rawR2Key;
    if (!bodyKey) throw new HTTPException(404, { message: "not found" });
    const obj = await c.env.BLOBS.get(bodyKey);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    const parsed = await parseMime(await obj.arrayBuffer());

    const atts = await db
      .select({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        inline: attachment.inline,
        contentId: attachment.contentId,
      })
      .from(attachment)
      .where(eq(attachment.messageId, id));

    // Remote images are routed through `/proxy-image` so opening a message
    // never leaks the reader's IP to the sender (tracking pixels); inline `cid:`
    // images are rewritten to the same-origin attachment route so they render.
    let html: string | null = null;
    if (parsed.html) {
      html = await proxyRemoteContent(parsed.html, await getOrCreateAuthSecret(db));
      const cidMap = new Map(
        atts.filter((a) => a.contentId).map((a) => [bareCid(a.contentId!), a.id]),
      );
      html = await rewriteInlineCids(html, id, cidMap);
    }
    // The raw `.eml` never changes once stored, so the parsed body is immutable.
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.json({
      html,
      text: parsed.text ?? null,
      attachments: atts,
      calendar: extractCalendar(parsed),
    } satisfies MessageBodyDto);
  });

  // Fetches a remote image referenced by a message body. Only URLs we signed
  // when rewriting the body are honored (HMAC), so this is not an open proxy.
  r.get("/proxy-image", async (c) => {
    const db = dbFromCtx(c);
    const encoded = c.req.query("u");
    const sig = c.req.query("s");
    if (!encoded || !sig) throw new HTTPException(400, { message: "missing params" });
    const secret = await getOrCreateAuthSecret(db);
    const url = await verifyProxyUrl(secret, encoded, sig);
    if (!url) throw new HTTPException(403, { message: "bad signature" });

    // Manual redirect following: every hop is re-checked against the SSRF
    // guard, so an attacker host can't 302 us at an internal address.
    const result = await safeRedirectFetch(new URL(url), { headers: { accept: "image/*" } });
    if ("blocked" in result) throw new HTTPException(403, { message: result.reason });
    const upstream = result;
    if (!upstream.ok || !upstream.body) throw new HTTPException(502, { message: "fetch failed" });
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/"))
      throw new HTTPException(415, { message: "not an image" });
    const declared = Number(upstream.headers.get("content-length") ?? "");
    if (declared > MAX_IMAGE_BYTES) throw new HTTPException(413, { message: "too large" });

    // Cap the stream too — a chunked response can omit content-length.
    let seen = 0;
    const limited = upstream.body.pipeThrough(
      new TransformStream<Uint8Array>({
        transform(chunk, ctrl) {
          seen += chunk.byteLength;
          if (seen > MAX_IMAGE_BYTES) ctrl.error(new Error("image too large"));
          else ctrl.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=86400",
        // The bytes are opaque image data; forbid them being treated as anything else.
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  });

  r.get("/:id/raw", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.READ);
    if (!msg.rawR2Key) throw new HTTPException(404, { message: "not found" });
    const obj = await c.env.BLOBS.get(msg.rawR2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    const headers: Record<string, string> = { "content-type": "message/rfc822" };
    // `?download` forces a save (Export) with a subject-derived filename;
    // otherwise the bytes are served inline for in-app viewing.
    if (c.req.query("download") !== undefined) {
      const name = `${slugifyForFile(msg.subject) || "email"}.eml`;
      headers["content-disposition"] = `attachment; filename="${name}"`;
    }
    return new Response(obj.body, { headers });
  });

  // Serve a stored attachment's bytes. Inline (cid) images load this directly in
  // the body iframe; `?download` forces a save dialog with the real filename.
  r.get("/:id/attachments/:attId/raw", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const attId = c.req.param("attId");
    // Gate on the parent message's mailbox RBAC, then confirm the attachment
    // belongs to it — an attacker can't graft another message's attachment id on.
    await requireEntityAccess(db, user.id, message, id, Perm.READ);
    const att = await db.query.attachment.findFirst({
      where: and(eq(attachment.id, attId), eq(attachment.messageId, id)),
    });
    if (!att) throw new HTTPException(404, { message: "not found" });
    const obj = await c.env.BLOBS.get(att.r2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });

    const headers: Record<string, string> = {
      "content-type": att.contentType,
      // The bytes are opaque user data — forbid sniffing them into active content
      // and deny any sub-resource loads if a viewer ever renders them as a doc.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    };
    if (c.req.query("download") !== undefined) {
      headers["content-disposition"] = contentDisposition(att.filename);
    }
    return new Response(obj.body, { headers });
  });

  return r;
}

// RFC 6266 Content-Disposition for a download: an ASCII-folded fallback plus a
// UTF-8 `filename*` so non-ASCII names survive. CR/LF/quotes are stripped to
// keep a crafted filename from injecting headers.
function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\r\n"\\]/g, "").trim() || "attachment";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
