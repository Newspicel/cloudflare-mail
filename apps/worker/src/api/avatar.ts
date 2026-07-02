import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 5 * 1024 * 1024;

export function avatarRoutes() {
  const r = new Hono<AppBindings>()

    // Serving is open to any signed-in user — avatars aren't secret and are shown
    // across the app. Auth still gates it so blobs aren't world-readable.
    .get("/:userId/:id", requireUser, async (c) => {
      const userId = c.req.param("userId");
      const id = c.req.param("id");
      if (!isSafe(userId) || !isSafe(id)) throw new HTTPException(400, { message: "bad key" });

      const obj = await c.env.BLOBS.get(`avatar/${userId}/${id}`);
      if (!obj) throw new HTTPException(404, { message: "not found" });
      const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
      return new Response(obj.body, {
        headers: {
          "content-type": ALLOWED.has(contentType) ? contentType : "application/octet-stream",
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    })

    .post("/", requireUser, async (c) => {
      const user = c.get("user")!;
      const contentType = c.req.header("content-type") ?? "";
      if (!ALLOWED.has(contentType)) throw new HTTPException(415, { message: "unsupported type" });

      const body = await c.req.raw.arrayBuffer();
      if (!body.byteLength) throw new HTTPException(400, { message: "empty" });
      if (body.byteLength > MAX_BYTES) throw new HTTPException(413, { message: "too large" });

      // One avatar per user — drop any prior blobs before writing the new one.
      const prefix = `avatar/${user.id}/`;
      const old = await c.env.BLOBS.list({ prefix });
      await Promise.all(old.objects.map((o) => c.env.BLOBS.delete(o.key)));

      const id = crypto.randomUUID();
      await c.env.BLOBS.put(`${prefix}${id}`, body, { httpMetadata: { contentType } });
      return c.json({ url: `/api/avatar/${user.id}/${id}` });
    });

  return r;
}

function isSafe(s: string): boolean {
  return /^[a-z0-9-]+$/i.test(s);
}
