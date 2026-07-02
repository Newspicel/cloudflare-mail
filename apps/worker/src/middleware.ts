import { user } from "@cfmail/db/schema";
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
  return next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "unauthenticated" });
  return next();
};

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const u = c.get("user");
  if (!u) throw new HTTPException(401, { message: "unauthenticated" });
  // The session user can be up to 60s stale (auth cookieCache). Admin routes
  // re-read role/ban from D1 so a demotion or ban cuts admin access immediately;
  // non-admin routes keep riding the cached session.
  const row = await dbFromCtx(c).query.user.findFirst({
    where: eq(user.id, u.id),
    columns: { role: true, banned: true },
  });
  if (!row || row.banned || row.role !== "admin") {
    throw new HTTPException(403, { message: "admin only" });
  }
  return next();
};
