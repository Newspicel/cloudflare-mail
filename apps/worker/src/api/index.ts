import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { createAuth } from "../auth.ts";
import type { AppBindings } from "../env.ts";
import { sessionMiddleware } from "../middleware.ts";
import { attachmentsRoutes } from "./attachments.ts";
import { domainsRoutes } from "./domains.ts";
import { mailboxesRoutes } from "./mailboxes.ts";
import { messagesRoutes } from "./messages.ts";
import { publicShareRoutes } from "./publicShare.ts";
import { streamRoute } from "./stream.ts";
import { tempRoutes } from "./temp.ts";
import { threadsRoutes } from "./threads.ts";

export function buildApi() {
  const app = new Hono<AppBindings>();

  app.use("*", logger());
  app.use(
    "/api/*",
    cors({
      origin: (o) => o ?? "",
      credentials: true,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.all("/api/auth/*", async (c) => {
    const auth = createAuth(c.env);
    return auth.handler(c.req.raw);
  });

  app.use("/api/*", sessionMiddleware);

  app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

  app.get("/api/me", (c) => {
    const user = c.get("user");
    return c.json({ user });
  });

  app.route("/api/domains", domainsRoutes());
  app.route("/api/mailboxes", mailboxesRoutes());
  app.route("/api/threads", threadsRoutes());
  app.route("/api/messages", messagesRoutes());
  app.route("/api/attachments", attachmentsRoutes());
  app.route("/api/temp", tempRoutes());
  app.route("/api/t", publicShareRoutes());
  app.get("/api/stream", streamRoute);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("unhandled", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
