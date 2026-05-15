import { mailboxInvite, mailboxMember } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { authFromCtx } from "./auth-ctx.ts";
import { dbFromCtx } from "./db.ts";
import type { AppBindings } from "./env.ts";

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = await authFromCtx(c);
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", sess?.user ?? null);
  c.set("sessionId", sess?.session?.id ?? null);

  // Materialize pending mailbox invites for this user's email.
  const u = sess?.user;
  if (u?.email) {
    const db = dbFromCtx(c);
    const pending = await db
      .select({
        id: mailboxInvite.id,
        mailboxId: mailboxInvite.mailboxId,
        perms: mailboxInvite.perms,
      })
      .from(mailboxInvite)
      .where(eq(mailboxInvite.email, u.email.toLowerCase()));
    await Promise.all(
      pending.map(async (inv) => {
        await db
          .insert(mailboxMember)
          .values({ mailboxId: inv.mailboxId, userId: u.id, perms: inv.perms })
          .onConflictDoUpdate({
            target: [mailboxMember.mailboxId, mailboxMember.userId],
            set: { perms: inv.perms },
          });
        await db.delete(mailboxInvite).where(eq(mailboxInvite.id, inv.id));
      }),
    );
  }

  return next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "unauthenticated" });
  return next();
};

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const u = c.get("user");
  if (!u) throw new HTTPException(401, { message: "unauthenticated" });
  if ((u as { role?: string }).role !== "admin") {
    throw new HTTPException(403, { message: "admin only" });
  }
  return next();
};
