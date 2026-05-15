import { domain, mailbox, mailboxInvite, mailboxMember, shareToken, user } from "@cfmail/db/schema";
import { grant, Perm } from "@cfmail/shared/permissions";
import {
  createMailbox,
  createShareToken,
  grantMember,
  updateMailboxSettings,
} from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
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

    await authorizeMailboxCreate(db, u, body.domainId, body.type);

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

  r.get("/:id/settings", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.READ);
    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { id: true, displayName: true, signature: true, replyTo: true, type: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    return c.json({
      id: mb.id,
      type: mb.type,
      displayName: mb.displayName,
      signature: mb.signature,
      replyTo: mb.replyTo,
    });
  });

  r.patch("/:id/settings", zValidator("json", updateMailboxSettings), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);

    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { type: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.type === "temp") {
      throw new HTTPException(400, { message: "temp mailboxes are not editable" });
    }

    const patch: Partial<{
      displayName: string | null;
      signature: string | null;
      replyTo: string | null;
    }> = {};
    if (body.displayName !== undefined) {
      patch.displayName = body.displayName?.trim() ? body.displayName.trim() : null;
    }
    if (body.signature !== undefined) {
      patch.signature = body.signature?.trim() ? body.signature : null;
    }
    if (body.replyTo !== undefined) {
      patch.replyTo = body.replyTo ? body.replyTo : null;
    }
    if (Object.keys(patch).length === 0) return c.json({ ok: true });

    await db.update(mailbox).set(patch).where(eq(mailbox.id, id));
    return c.json({ ok: true });
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

    let perms = 0;
    if (body.read) perms = grant(perms, Perm.READ);
    if (body.write) perms = grant(perms, Perm.WRITE);
    if (body.manage) perms = grant(perms, Perm.MANAGE);

    let targetUserId = body.userId;
    if (!targetUserId && body.email) {
      const found = await db.query.user.findFirst({
        where: eq(user.email, body.email.toLowerCase()),
        columns: { id: true },
      });
      if (!found) {
        const inviteId = crypto.randomUUID();
        await db
          .insert(mailboxInvite)
          .values({
            id: inviteId,
            mailboxId: id,
            email: body.email.toLowerCase(),
            perms,
            invitedByUserId: u.id,
          })
          .onConflictDoUpdate({
            target: [mailboxInvite.mailboxId, mailboxInvite.email],
            set: { perms, invitedByUserId: u.id },
          });
        return c.json({ ok: true, invited: true, email: body.email.toLowerCase() }, 202);
      }
      targetUserId = found.id;
    }
    if (!targetUserId) throw new HTTPException(400, { message: "userId or email required" });

    await db
      .insert(mailboxMember)
      .values({ mailboxId: id, userId: targetUserId, perms })
      .onConflictDoUpdate({
        target: [mailboxMember.mailboxId, mailboxMember.userId],
        set: { perms },
      });
    return c.json({ ok: true, userId: targetUserId });
  });

  r.get("/:id/invites", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    const rows = await db
      .select({
        id: mailboxInvite.id,
        email: mailboxInvite.email,
        perms: mailboxInvite.perms,
        createdAt: mailboxInvite.createdAt,
      })
      .from(mailboxInvite)
      .where(eq(mailboxInvite.mailboxId, id));
    return c.json({ invites: rows });
  });

  r.delete("/:id/invites/:inviteId", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const inviteId = c.req.param("inviteId");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .delete(mailboxInvite)
      .where(and(eq(mailboxInvite.id, inviteId), eq(mailboxInvite.mailboxId, id)));
    return c.body(null, 204);
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
    const baseUrl = c.get("baseUrl");
    const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/t/${tokenId}` : `/t/${tokenId}`;
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
