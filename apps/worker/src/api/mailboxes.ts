import { domain, mailbox, mailboxMember } from "@cfmail/db/schema";
import { grant, Perm } from "@cfmail/shared/permissions";
import { createMailbox, grantMember } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

export function mailboxesRoutes() {
  const r = new Hono<AppBindings>();

  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;

    const ownerRows = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        expiresAt: mailbox.expiresAt,
        domainName: domain.name,
        access: mailbox.ownerUserId,
      })
      .from(mailbox)
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .where(eq(mailbox.ownerUserId, user.id));

    const memberRows = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        expiresAt: mailbox.expiresAt,
        domainName: domain.name,
        perms: mailboxMember.perms,
      })
      .from(mailboxMember)
      .innerJoin(mailbox, eq(mailboxMember.mailboxId, mailbox.id))
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .where(eq(mailboxMember.userId, user.id));

    const owned = ownerRows.map((m) => ({
      id: m.id,
      address: `${m.localPart}@${m.domainName}`,
      displayName: m.displayName,
      type: m.type,
      expiresAt: m.expiresAt,
      role: "owner" as const,
      perms: 7,
    }));
    const shared = memberRows.map((m) => ({
      id: m.id,
      address: `${m.localPart}@${m.domainName}`,
      displayName: m.displayName,
      type: m.type,
      expiresAt: m.expiresAt,
      role: "member" as const,
      perms: m.perms,
    }));

    return c.json({ mailboxes: [...owned, ...shared] });
  });

  r.post("/", zValidator("json", createMailbox), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");

    const dom = await db.query.domain.findFirst({
      where: eq(domain.id, body.domainId),
      columns: { id: true },
    });
    if (!dom) throw new HTTPException(400, { message: "domain not found" });

    const id = crypto.randomUUID();
    const expiresAt = body.ttlSeconds ? new Date(Date.now() + body.ttlSeconds * 1000) : null;

    await db.insert(mailbox).values({
      id,
      domainId: body.domainId,
      localPart: body.localPart.toLowerCase(),
      displayName: body.displayName ?? null,
      type: body.type,
      ownerUserId: user.id,
      signature: body.signature ?? null,
      replyTo: body.replyTo ?? null,
      expiresAt,
    });

    return c.json({ id }, 201);
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { ownerUserId: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.ownerUserId !== user.id) throw new HTTPException(403, { message: "owner only" });
    const keys = await collectMailboxBlobKeys(db, id);
    await deleteBlobs(c.env, keys);
    await db.delete(mailbox).where(eq(mailbox.id, id));
    return c.body(null, 204);
  });

  r.get("/:id/members", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, user.id, id, Perm.MANAGE);
    const rows = await db
      .select({ userId: mailboxMember.userId, perms: mailboxMember.perms })
      .from(mailboxMember)
      .where(eq(mailboxMember.mailboxId, id));
    return c.json({ members: rows });
  });

  r.post("/:id/members", zValidator("json", grantMember), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, user.id, id, Perm.MANAGE);

    let perms = 0;
    if (body.read) perms = grant(perms, Perm.READ);
    if (body.write) perms = grant(perms, Perm.WRITE);
    if (body.manage) perms = grant(perms, Perm.MANAGE);

    await db
      .insert(mailboxMember)
      .values({ mailboxId: id, userId: body.userId, perms })
      .onConflictDoUpdate({
        target: [mailboxMember.mailboxId, mailboxMember.userId],
        set: { perms },
      });
    return c.json({ ok: true });
  });

  r.delete("/:id/members/:userId", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const uid = c.req.param("userId");
    await requirePerm(db, user.id, id, Perm.MANAGE);
    await db
      .delete(mailboxMember)
      .where(and(eq(mailboxMember.mailboxId, id), eq(mailboxMember.userId, uid)));
    return c.body(null, 204);
  });

  // Suppress unused-import warning from tree-shaking of `or`.
  void or;
  return r;
}
