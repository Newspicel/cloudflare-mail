import type { Context } from "hono";
import { type Auth, baseUrlFromRequest, createAuth } from "./auth.ts";
import { dbFromCtx } from "./db.ts";
import type { AppBindings } from "./env.ts";

export async function authFromCtx(c: Context<AppBindings>): Promise<Auth> {
  const cached = c.get("auth");
  if (cached) return cached;
  const baseURL = baseUrlFromRequest(c.req.raw);
  c.set("baseUrl", baseURL);
  const auth = await createAuth({ env: c.env, db: dbFromCtx(c), baseURL });
  c.set("auth", auth);
  return auth;
}
