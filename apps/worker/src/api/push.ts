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
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
      return false;
    // IPv4 literal, bracketed IPv6 literal, or no dot (bare hostname) — none are real push services.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".")) {
      return false;
    }
    return true;
  }, "endpoint must be a public https URL");

const subscribeBody = z.object({
  endpoint: pushEndpoint,
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const toggleBody = z.object({ enabled: z.boolean() });

export function pushRoutes() {
  const r = new Hono<AppBindings>();

  r.use("*", requireUser);

  // VAPID application server key the browser needs to subscribe.
  r.get("/key", async (c) => {
    const { publicKey } = await getOrCreateVapid(dbFromCtx(c));
    return c.json({ publicKey });
  });

  // Register (or refresh) this device's push subscription for the current user.
  r.post("/subscribe", zValidator("json", subscribeBody), async (c) => {
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
  });

  r.post("/unsubscribe", zValidator("json", z.object({ endpoint: z.string() })), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const { endpoint } = c.req.valid("json");
    await db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, u.id)));
    return c.body(null, 204);
  });

  // Mailboxes this user has opted into notifications for.
  r.get("/mailboxes", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const rows = await db
      .select({ mailboxId: mailboxNotify.mailboxId })
      .from(mailboxNotify)
      .where(eq(mailboxNotify.userId, u.id));
    return c.json({ enabled: rows.map((row) => row.mailboxId) });
  });

  r.put("/mailboxes/:id", zValidator("json", toggleBody), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const { enabled } = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.READ);
    if (enabled) {
      await db.insert(mailboxNotify).values({ mailboxId: id, userId: u.id }).onConflictDoNothing();
    } else {
      await db
        .delete(mailboxNotify)
        .where(and(eq(mailboxNotify.mailboxId, id), eq(mailboxNotify.userId, u.id)));
    }
    return c.json({ ok: true, enabled });
  });

  return r;
}
