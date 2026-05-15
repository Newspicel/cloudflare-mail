import { domain } from "@cfmail/db/schema";
import { createDomain, updateDomain } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { checkDomainHealth } from "../mail/dns.ts";
import { requireUser } from "../middleware.ts";

export function domainsRoutes() {
  const r = new Hono<AppBindings>();

  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const rows = await db.select().from(domain).orderBy(asc(domain.name));
    return c.json({ domains: rows });
  });

  r.post("/", zValidator("json", createDomain), async (c) => {
    const db = dbFromCtx(c);
    const body = c.req.valid("json");
    const id = crypto.randomUUID();
    await db.insert(domain).values({
      id,
      name: body.name.toLowerCase(),
      kind: body.kind,
    });
    return c.json({ id }, 201);
  });

  r.patch("/:id", zValidator("json", updateDomain), async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const patch: Partial<{ isTempDomain: boolean }> = {};
    if (body.isTempDomain !== undefined) patch.isTempDomain = body.isTempDomain;
    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    const res = await db.update(domain).set(patch).where(eq(domain.id, id));
    if (!res.success) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const res = await db.delete(domain).where(eq(domain.id, id));
    if (!res.success) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  r.post("/:id/check", async (c) => {
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
