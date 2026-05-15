import { domain, mailbox } from "@cfmail/db/schema";
import { createTempMailbox } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
import { requireUser } from "../middleware.ts";

export function tempRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.post("/", zValidator("json", createTempMailbox), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const body = c.req.valid("json");

    await authorizeMailboxCreate(db, u, body.domainId, "temp");

    const dom = await db.query.domain.findFirst({
      where: eq(domain.id, body.domainId),
      columns: { id: true, name: true },
    });
    if (!dom) throw new HTTPException(400, { message: "domain not found" });

    const localPart = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000);

    await db.insert(mailbox).values({
      id,
      domainId: dom.id,
      localPart,
      displayName: body.displayName ?? null,
      type: "temp",
      ownerUserId: u.id,
      expiresAt,
    });

    return c.json(
      {
        id,
        address: `${localPart}@${dom.name}`,
        expiresAt: expiresAt.toISOString(),
      },
      201,
    );
  });

  return r;
}
