import { domain, mailbox, mailboxMember, shareToken, user } from "@cfmail/db/schema";
import { grant, Perm } from "@cfmail/shared/permissions";
import { createMailbox, createShareToken, grantMember } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, or } from "drizzle-orm";
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
    const u = c.get("user")!;

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
      .where(eq(mailbox.ownerUserId, u.id));

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
      .where(eq(mailboxMember.userId, u.id));

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
    const u = c.get("user")!;
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
      ownerUserId: u.id,
      signature: body.signature ?? null,
      replyTo: body.replyTo ?? null,
      expiresAt,
    });

    return c.json({ id }, 201);
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { ownerUserId: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.ownerUserId !== u.id) throw new HTTPException(403, { message: "owner only" });
    const keys = await collectMailboxBlobKeys(db, id);
    await deleteBlobs(c.env, keys);
    await db.delete(mailbox).where(eq(mailbox.id, id));
    return c.body(null, 204);
  });

  r.get("/:id/members", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    const rows = await db
      .select({
        userId: mailboxMember.userId,
        perms: mailboxMember.perms,
        email: user.email,
        name: user.name,
      })
      .from(mailboxMember)
      .innerJoin(user, eq(user.id, mailboxMember.userId))
      .where(eq(mailboxMember.mailboxId, id));
    return c.json({ members: rows });
  });

  r.post("/:id/members", zValidator("json", grantMember), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);

    let targetUserId = body.userId;
    if (!targetUserId && body.email) {
      const found = await db.query.user.findFirst({
        where: eq(user.email, body.email.toLowerCase()),
        columns: { id: true },
      });
      if (!found) throw new HTTPException(404, { message: "user not found" });
      targetUserId = found.id;
    }
    if (!targetUserId) throw new HTTPException(400, { message: "userId or email required" });

    let perms = 0;
    if (body.read) perms = grant(perms, Perm.READ);
    if (body.write) perms = grant(perms, Perm.WRITE);
    if (body.manage) perms = grant(perms, Perm.MANAGE);

    await db
      .insert(mailboxMember)
      .values({ mailboxId: id, userId: targetUserId, perms })
      .onConflictDoUpdate({
        target: [mailboxMember.mailboxId, mailboxMember.userId],
        set: { perms },
      });
    return c.json({ ok: true, userId: targetUserId });
  });

  r.delete("/:id/members/:userId", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const uid = c.req.param("userId");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .delete(mailboxMember)
      .where(and(eq(mailboxMember.mailboxId, id), eq(mailboxMember.userId, uid)));
    return c.body(null, 204);
  });

  r.post("/:id/share-tokens", zValidator("json", createShareToken), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);

    const tokenId = randomToken(32);
    const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000);
    await db.insert(shareToken).values({
      id: tokenId,
      mailboxId: id,
      createdByUserId: u.id,
      perms: Perm.READ,
      expiresAt,
    });
    const url = c.env.APP_URL
      ? `${c.env.APP_URL.replace(/\/$/, "")}/t/${tokenId}`
      : `/t/${tokenId}`;
    return c.json({ id: tokenId, url, expiresAt: expiresAt.toISOString() }, 201);
  });

  r.get("/:id/share-tokens", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    const rows = await db
      .select({
        id: shareToken.id,
        createdAt: shareToken.createdAt,
        expiresAt: shareToken.expiresAt,
      })
      .from(shareToken)
      .where(eq(shareToken.mailboxId, id))
      .orderBy(desc(shareToken.createdAt));
    return c.json({ tokens: rows });
  });

  r.delete("/:id/share-tokens/:tokenId", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const tokenId = c.req.param("tokenId");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .delete(shareToken)
      .where(and(eq(shareToken.id, tokenId), eq(shareToken.mailboxId, id)));
    return c.body(null, 204);
  });

  // Suppress unused-import warning from tree-shaking of `or`.
  void or;
  return r;
}

function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
