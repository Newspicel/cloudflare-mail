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

const subscribeBody = z.object({
  endpoint: z.string().url(),
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
