import { domain, domainGrant, user, userInvite } from "@cfmail/db/schema";
import {
  acceptInvite,
  adminCreateUser,
  adminUpdateUser,
  createUserInvite,
  upsertDomainGrant,
} from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { sendMail } from "../mail/notify.ts";
import { requireAdmin, requireUser } from "../middleware.ts";
import { createUserWithPassword } from "./bootstrap.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function usersRoutes() {
  const r = new Hono<AppBindings>();

  // Public invite acceptance — token-gated, no session required.
  r.post("/invites/accept", zValidator("json", acceptInvite), async (c) => {
    const db = dbFromCtx(c);
    const body = c.req.valid("json");

    const inv = await db.query.userInvite.findFirst({
      where: eq(userInvite.token, body.token),
    });
    if (!inv) throw new HTTPException(404, { message: "invite not found" });
    if (inv.usedAt) throw new HTTPException(410, { message: "invite already used" });
    if (inv.expiresAt.getTime() < Date.now()) {
      throw new HTTPException(410, { message: "invite expired" });
    }

    await createUserWithPassword(db, {
      email: inv.email,
      name: body.name,
      password: body.password,
      role: inv.role,
    });
    await db.update(userInvite).set({ usedAt: new Date() }).where(eq(userInvite.id, inv.id));

    return c.json({ ok: true });
  });

  // Look up an invite by token without consuming it — for the accept page.
  r.get("/invites/by-token/:token", async (c) => {
    const db = dbFromCtx(c);
    const token = c.req.param("token");
    const inv = await db.query.userInvite.findFirst({
      where: eq(userInvite.token, token),
      columns: { email: true, role: true, usedAt: true, expiresAt: true },
    });
    if (!inv) throw new HTTPException(404, { message: "invite not found" });
    return c.json({
      email: inv.email,
      role: inv.role,
      used: !!inv.usedAt,
      expired: inv.expiresAt.getTime() < Date.now(),
    });
  });

  // Minimal user directory for member selection — any signed-in user, no admin.
  // Used by the group-mailbox members panel to pick existing accounts.
  r.get("/directory", requireUser, async (c) => {
    const db = dbFromCtx(c);
    const rows = await db
      .select({ id: user.id, email: user.email, name: user.name })
      .from(user)
      .where(eq(user.banned, false))
      .orderBy(asc(user.email));
    return c.json({ users: rows });
  });

  // Everything below requires admin.
  r.use("*", requireUser, requireAdmin);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const rows = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        banned: user.banned,
        createdAt: user.createdAt,
      })
      .from(user)
      .orderBy(asc(user.createdAt));
    return c.json({ users: rows });
  });

  r.post("/", zValidator("json", adminCreateUser), async (c) => {
    const db = dbFromCtx(c);
    const body = c.req.valid("json");
    const created = await createUserWithPassword(db, {
      email: body.email,
      name: body.name,
      password: body.password,
      role: body.role,
    });
    return c.json({ id: created.id }, 201);
  });

  r.patch("/:id", zValidator("json", adminUpdateUser), async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");

    if (id === me.id && body.role && body.role !== "admin") {
      throw new HTTPException(400, { message: "cannot demote yourself" });
    }

    const patch: Partial<{ role: "admin" | "user"; banned: boolean }> = {};
    if (body.role !== undefined) patch.role = body.role;
    if (body.banned !== undefined) patch.banned = body.banned;
    if (Object.keys(patch).length === 0) return c.json({ ok: true });

    const res = await db.update(user).set(patch).where(eq(user.id, id));
    if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const id = c.req.param("id");
    if (id === me.id) throw new HTTPException(400, { message: "cannot delete yourself" });
    const res = await db.delete(user).where(eq(user.id, id));
    if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  r.get("/invites", async (c) => {
    const db = dbFromCtx(c);
    const rows = await db.select().from(userInvite).orderBy(asc(userInvite.createdAt));
    return c.json({ invites: rows });
  });

  r.post("/invites", zValidator("json", createUserInvite), async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const body = c.req.valid("json");
    const email = body.email.toLowerCase();

    const existingUser = await db.query.user.findFirst({
      where: eq(user.email, email),
      columns: { id: true },
    });
    if (existingUser) throw new HTTPException(409, { message: "user exists" });

    const token = randomToken(32);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    await db
      .insert(userInvite)
      .values({
        id,
        email,
        role: body.role,
        token,
        invitedByUserId: me.id,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: userInvite.email,
        set: { token, role: body.role, invitedByUserId: me.id, expiresAt, usedAt: null },
      });

    const baseUrl = c.get("baseUrl");
    const url = `${baseUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    const from = await getConfig(db, "auth_from_address");
    if (from) {
      await sendMail(c.env, {
        from,
        to: email,
        subject: "You've been invited",
        text: `You've been invited to join. Set your password:\n\n${url}\n\nThis link expires in 7 days.`,
      });
    }

    return c.json({ ok: true, id, url, sentEmail: !!from }, 201);
  });

  r.delete("/invites/:id", async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const res = await db.delete(userInvite).where(eq(userInvite.id, id));
    if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  // Per-user domain grants — controls which mailbox kinds a user may create
  // on a given domain. Admins bypass.
  r.get("/:id/domain-grants", async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const rows = await db
      .select({
        domainId: domainGrant.domainId,
        domainName: domain.name,
        allowedKinds: domainGrant.allowedKinds,
      })
      .from(domainGrant)
      .innerJoin(domain, eq(domain.id, domainGrant.domainId))
      .where(eq(domainGrant.userId, id));
    return c.json({ grants: rows });
  });

  r.put("/:id/domain-grants/:domainId", zValidator("json", upsertDomainGrant), async (c) => {
    const db = dbFromCtx(c);
    const userId = c.req.param("id");
    const domainId = c.req.param("domainId");
    const body = c.req.valid("json");

    await db
      .insert(domainGrant)
      .values({ domainId, userId, allowedKinds: body.allowedKinds })
      .onConflictDoUpdate({
        target: [domainGrant.domainId, domainGrant.userId],
        set: { allowedKinds: body.allowedKinds },
      });
    return c.json({ ok: true });
  });

  r.delete("/:id/domain-grants/:domainId", async (c) => {
    const db = dbFromCtx(c);
    const userId = c.req.param("id");
    const domainId = c.req.param("domainId");
    await db
      .delete(domainGrant)
      .where(and(eq(domainGrant.userId, userId), eq(domainGrant.domainId, domainId)));
    return c.body(null, 204);
  });

  return r;
}

function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
