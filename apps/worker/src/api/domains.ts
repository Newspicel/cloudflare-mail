import { domain } from "@cfmail/db/schema";
import { createDomain, setAuthFromAddress, updateDomain } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig, setConfig } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { checkDomainHealth } from "../mail/dns.ts";
import { requireAdmin, requireUser } from "../middleware.ts";

export function domainsRoutes() {
  const r = new Hono<AppBindings>();

  // List is visible to any signed-in user (they need it to pick a domain
  // when creating a mailbox). Mutations are admin-only below.
  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const rows = await db.select().from(domain).orderBy(asc(domain.name));
    return c.json({ domains: rows });
  });

  r.get("/settings", requireAdmin, async (c) => {
    const db = dbFromCtx(c);
    const fromAddr = await getConfig(db, "auth_from_address");
    return c.json({ authFromAddress: fromAddr });
  });

  r.put("/settings/auth-from", requireAdmin, zValidator("json", setAuthFromAddress), async (c) => {
    const db = dbFromCtx(c);
    const body = c.req.valid("json");
    const address = body.address.toLowerCase();
    const domainName = address.slice(address.indexOf("@") + 1);
    const row = await db.query.domain.findFirst({
      where: eq(domain.name, domainName),
      columns: { spfOk: true, dkimOk: true },
    });
    if (!row) {
      throw new HTTPException(400, {
        message: `${domainName} is not a configured domain`,
      });
    }
    if (!row.spfOk || !row.dkimOk) {
      throw new HTTPException(400, {
        message: `${domainName} is not verified for sending (SPF and DKIM must pass)`,
      });
    }
    await setConfig(db, "auth_from_address", address);
    return c.json({ ok: true });
  });

  r.post("/", requireAdmin, zValidator("json", createDomain), async (c) => {
    const db = dbFromCtx(c);
    const body = c.req.valid("json");
    const id = crypto.randomUUID();
    await db.insert(domain).values({
      id,
      name: body.name.toLowerCase(),
      allowedKinds: body.allowedKinds,
    });
    return c.json({ id }, 201);
  });

  r.patch("/:id", requireAdmin, zValidator("json", updateDomain), async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const patch: Partial<{ allowedKinds: number }> = {};
    if (body.allowedKinds !== undefined) patch.allowedKinds = body.allowedKinds;
    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    const res = await db.update(domain).set(patch).where(eq(domain.id, id));
    if (!res.success) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  });

  r.delete("/:id", requireAdmin, async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const res = await db.delete(domain).where(eq(domain.id, id));
    if (!res.success) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  r.post("/:id/check", requireAdmin, async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const row = await db.query.domain.findFirst({
      where: eq(domain.id, id),
      columns: { id: true, name: true },
    });
    if (!row) throw new HTTPException(404, { message: "not found" });
    const health = await checkDomainHealth(row.name);
    const now = new Date();
    await db
      .update(domain)
      .set({ ...health, lastCheckedAt: now })
      .where(eq(domain.id, id));
    return c.json({ ...health, lastCheckedAt: now.toISOString() });
  });

  return r;
}
