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
import { isBlockedHost, MAX_IMAGE_BYTES, proxyImages, verifyProxyUrl } from "../mail/img-proxy.ts";
import { parseMime } from "../mail/mime.ts";
import { sendFromMailbox } from "../mail/send.ts";
import { recomputeThreadUnread } from "../mail/threads.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

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
    const result = await sendFromMailbox(c.env, db, user.id, body);
    return c.json(result, 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const patch = c.req.valid("json");

    const msg = await db.query.message.findFirst({
      where: eq(message.id, id),
      columns: { mailboxId: true, threadId: true, flags: true },
    });
    if (!msg) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, msg.mailboxId, Perm.READ);

    let flags = msg.flags;
    if (patch.seen !== undefined) flags = setFlag(flags, Flag.SEEN, patch.seen);
    if (patch.starred !== undefined) flags = setFlag(flags, Flag.STARRED, patch.starred);
    if (patch.trash !== undefined) flags = setFlag(flags, Flag.TRASH, patch.trash);

    await db.update(message).set({ flags }).where(eq(message.id, id));
    // SEEN drives the thread's unread badge; keep the cached count in sync.
    if (patch.seen !== undefined) await recomputeThreadUnread(db, msg.threadId);
    return c.json({ flags });
  });

  // Full body, parsed on demand from the raw `.eml`. Listing endpoints only
  // carry the snippet; this is fetched lazily when a message is opened.
  r.get("/:id/body", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const msg = await db.query.message.findFirst({
      where: eq(message.id, id),
      columns: { mailboxId: true, rawR2Key: true },
    });
    if (!msg?.rawR2Key) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, msg.mailboxId, Perm.READ);
    const obj = await c.env.BLOBS.get(msg.rawR2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    const parsed = await parseMime(await obj.arrayBuffer());
    // Remote images are routed through `/proxy-image` so opening a message
    // never leaks the reader's IP to the sender (tracking pixels).
    const html = parsed.html
      ? await proxyImages(parsed.html, await getOrCreateAuthSecret(db))
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

    const target = new URL(url);
    if (isBlockedHost(target.hostname)) throw new HTTPException(403, { message: "blocked host" });

    const upstream = await fetch(target, {
      headers: { accept: "image/*" },
      redirect: "follow",
    });
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
    const msg = await db.query.message.findFirst({
      where: eq(message.id, id),
      columns: { mailboxId: true, rawR2Key: true },
    });
    if (!msg?.rawR2Key) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, msg.mailboxId, Perm.READ);
    const obj = await c.env.BLOBS.get(msg.rawR2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    return new Response(obj.body, {
      headers: { "content-type": "message/rfc822" },
    });
  });

  return r;
}
