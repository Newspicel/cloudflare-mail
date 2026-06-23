import { checkBlockRecipients } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { blockedAddresses } from "../mail/blocklist.ts";
import { requireUser } from "../middleware.ts";

// Reader-facing blocklist lookups. The admin-managed list itself lives at
// /api/admin/block; this just lets the composer warn before sending to a
// blocked recipient. Mounted at /api/blocklist.
export function blocklistRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.post("/check", zValidator("json", checkBlockRecipients), async (c) => {
    const db = dbFromCtx(c);
    const { addresses } = c.req.valid("json");
    return c.json({ blocked: await blockedAddresses(db, addresses) });
  });

  return r;
}
