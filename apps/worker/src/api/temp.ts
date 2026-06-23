import { domain, domainGrant, mailbox } from "@cfmail/db/schema";
import { kindBit } from "@cfmail/shared/permissions";
import { createTempMailbox } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
import { requireUser } from "../middleware.ts";

export function tempRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  // Temp domains the current user may actually create on. Admins get every
  // TEMP-enabled domain; non-admins are further filtered by their domain_grant
  // (mirrors authorizeMailboxCreate). Empty list => UI hides the temp button.
  r.get("/domains", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const bit = kindBit("temp");
    const rows = await db
      .select({ id: domain.id, name: domain.name, allowedKinds: domain.allowedKinds })
      .from(domain)
      .orderBy(asc(domain.name));
    let temp = rows.filter((d) => (d.allowedKinds & bit) === bit);
    if ((u as { role?: string }).role !== "admin") {
      const grants = await db
        .select({ domainId: domainGrant.domainId, allowedKinds: domainGrant.allowedKinds })
        .from(domainGrant)
        .where(eq(domainGrant.userId, u.id));
      const grantedTemp = new Set(
        grants.filter((g) => (g.allowedKinds & bit) === bit).map((g) => g.domainId),
      );
      temp = temp.filter((d) => grantedTemp.has(d.id));
    }
    return c.json({ domains: temp });
  });

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
