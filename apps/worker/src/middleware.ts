import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAuth } from "./auth.ts";
import type { AppBindings } from "./env.ts";

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = createAuth(c.env);
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", sess?.user ?? null);
  c.set("sessionId", sess?.session?.id ?? null);
  return next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "unauthenticated" });
  return next();
};
