import type { Handler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../env.ts";

export const streamRoute: Handler<AppBindings> = async (c) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "unauthenticated" });
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id));
  return stub.fetch("https://hub/subscribe");
};
