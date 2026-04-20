import { domain } from "@cfmail/db/schema";
import { createDomain } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
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

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const res = await db.delete(domain).where(eq(domain.id, id));
    if (!res.success) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  return r;
}
