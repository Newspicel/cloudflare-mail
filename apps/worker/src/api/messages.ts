import { message } from "@cfmail/db/schema";
import { Flag, setFlag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import type { MessageBodyDto } from "@cfmail/shared/responses";
import { sendMessage } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getOrCreateAuthSecret } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { assertOwnedAttachmentKeys } from "../mail/attachment-keys.ts";
import {
  MAX_IMAGE_BYTES,
  proxyRemoteContent,
  safeRedirectFetch,
  verifyProxyUrl,
} from "../mail/img-proxy.ts";
import { parseMime } from "../mail/mime.ts";
import { buildQuote } from "../mail/quote.ts";
import { sendFromMailbox } from "../mail/send.ts";
import { recomputeThreadUnread } from "../mail/threads.ts";
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
    // SEEN drives the thread's unread badge; keep the cached count in sync.
    if (patch.seen !== undefined) await recomputeThreadUnread(db, msg.threadId);
    return c.json({ flags });
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

  // Full body, parsed on demand from the raw `.eml`. Listing endpoints only
  // carry the snippet; this is fetched lazily when a message is opened.
  r.get("/:id/body", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const msg = await requireEntityAccess(db, user.id, message, id, Perm.READ);
    if (!msg.rawR2Key) throw new HTTPException(404, { message: "not found" });
    const obj = await c.env.BLOBS.get(msg.rawR2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    const parsed = await parseMime(await obj.arrayBuffer());
    // Remote images are routed through `/proxy-image` so opening a message
    // never leaks the reader's IP to the sender (tracking pixels).
    const html = parsed.html
      ? await proxyRemoteContent(parsed.html, await getOrCreateAuthSecret(db))
      : null;
    // The raw `.eml` never changes once stored, so the parsed body is immutable.
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.json({ html, text: parsed.text ?? null } satisfies MessageBodyDto);
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

  return r;
}
