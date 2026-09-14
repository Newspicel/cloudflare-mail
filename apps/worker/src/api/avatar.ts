import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { cachedBimiLogo, normalizeDomain, resolveBimiLogo } from "../mail/bimi.ts";
import { requireUser } from "../middleware.ts";
import { enforceRateLimit } from "../rate-limit.ts";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 5 * 1024 * 1024;

export function avatarRoutes() {
  const r = new Hono<AppBindings>()

    // A sender's BIMI logo, by organizational domain. Any signed-in user may
    // ask — the answer is public DNS plus a public HTTPS file, and a reader
    // needs it for every correspondent. Rate-limited so it can't be used to
    // make the Worker crawl arbitrary hosts, and cached hard on the way out:
    // the underlying record has a multi-day TTL of its own.
    .get("/domain/:domain", requireUser, async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const domain = normalizeDomain(c.req.param("domain"));
      if (!domain) throw new HTTPException(400, { message: "bad domain" });

      // A remembered answer costs one indexed D1 read, so it isn't rate
      // limited; only a domain we've never looked up makes the Worker do DNS
      // and an outbound fetch, and that is what the limit is for.
      let logo = await cachedBimiLogo(db, domain);
      if (logo === "stale") {
        await enforceRateLimit(db, "bimi", user.id, 120, 60 * 60 * 1000);
        logo = await resolveBimiLogo(db, domain);
      }
      // Most domains publish no logo. Say so in a way the client can cache, so
      // a mailbox full of ordinary senders asks once a day, not once a render.
      if (!logo) {
        return new Response(null, {
          status: 404,
          headers: { "cache-control": "private, max-age=86400" },
        });
      }

      return new Response(logo.svg, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          // Referenced from <img>, so script inside never runs; the sandbox
          // directive covers the case where someone opens the URL directly.
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=86400",
          // The mark is asserted by the domain, not verified by us.
          "x-bimi-authority": logo.hasAuthority ? "asserted" : "none",
        },
      });
    })

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
