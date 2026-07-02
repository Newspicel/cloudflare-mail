import { NOTIFY_LEVELS } from "@cfmail/db/enums";
import { mailboxNotify, pushSubscription } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { getOrCreateVapid } from "../mail/push.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";
import { isBlockedHost } from "../ssrf.ts";

// Push endpoints are always public HTTPS hosts handed out by a browser push
// service. Reject anything else at registration so the fan-out fetch can never
// be steered at a non-HTTPS scheme, an IP literal, or a loopback/internal host.
const pushEndpoint = z
  .string()
  .url()
  .refine((u) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return false;
    }
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    // Bracketed IPv6 literal or no dot (bare hostname) — never a real push
    // service. `isBlockedHost` additionally rejects loopback/private/reserved
    // targets in any IPv4 encoding (e.g. `127.1`, `0x7f000001`).
    if (host.includes(":") || !host.includes(".")) return false;
    if (isBlockedHost(host)) return false;
    return true;
  }, "endpoint must be a public https URL");

const subscribeBody = z.object({
  endpoint: pushEndpoint,
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const lvl = z.enum(NOTIFY_LEVELS);
const configBody = z.object({ high: lvl, normal: lvl, low: lvl });

export function pushRoutes() {
  const r = new Hono<AppBindings>()

    .use("*", requireUser)

    // VAPID application server key the browser needs to subscribe.
    .get("/key", async (c) => {
      const { publicKey } = await getOrCreateVapid(dbFromCtx(c));
      return c.json({ publicKey });
    })

    // Register (or refresh) this device's push subscription for the current user.
    .post("/subscribe", zValidator("json", subscribeBody), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const body = c.req.valid("json");
      await db
        .insert(pushSubscription)
        .values({
          id: crypto.randomUUID(),
          userId: u.id,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent: c.req.header("user-agent") ?? null,
        })
        .onConflictDoUpdate({
          target: pushSubscription.endpoint,
          set: { userId: u.id, p256dh: body.keys.p256dh, auth: body.keys.auth },
        });
      return c.json({ ok: true });
    })

    .post("/unsubscribe", zValidator("json", z.object({ endpoint: z.string() })), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const { endpoint } = c.req.valid("json");
      await db
        .delete(pushSubscription)
        .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, u.id)));
      return c.body(null, 204);
    })

    // Per-mailbox notification config for this user. Each tier (high/normal/low)
    // maps to a style; an absent mailbox means off.
    .get("/mailboxes", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const rows = await db
        .select({
          mailboxId: mailboxNotify.mailboxId,
          high: mailboxNotify.high,
          normal: mailboxNotify.normal,
          low: mailboxNotify.low,
        })
        .from(mailboxNotify)
        .where(eq(mailboxNotify.userId, u.id));
      return c.json({ configs: rows });
    })

    .put("/mailboxes/:id", zValidator("json", configBody), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const cfg = c.req.valid("json");
      await requirePerm(db, u.id, id, Perm.READ);
      // All-none means "off" — drop the row so it no longer notifies.
      if (cfg.high === "none" && cfg.normal === "none" && cfg.low === "none") {
        await db
          .delete(mailboxNotify)
          .where(and(eq(mailboxNotify.mailboxId, id), eq(mailboxNotify.userId, u.id)));
        return c.json({ ok: true });
      }
      await db
        .insert(mailboxNotify)
        .values({ mailboxId: id, userId: u.id, ...cfg })
        .onConflictDoUpdate({
          target: [mailboxNotify.mailboxId, mailboxNotify.userId],
          set: cfg,
        });
      return c.json({ ok: true });
    });

  return r;
}
