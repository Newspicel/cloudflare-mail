import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { authFromCtx } from "../auth-ctx.ts";
import type { AppBindings } from "../env.ts";
import { sessionMiddleware } from "../middleware.ts";
import { adminRoutes } from "./admin.ts";
import { attachmentsRoutes } from "./attachments.ts";
import { bootstrapRoutes } from "./bootstrap.ts";
import { contactsRoutes } from "./contacts.ts";
import { domainsRoutes } from "./domains.ts";
import { draftsRoutes } from "./drafts.ts";
import { labelsRoutes } from "./labels.ts";
import { mailboxesRoutes } from "./mailboxes.ts";
import { messagesRoutes } from "./messages.ts";
import { publicShareRoutes } from "./publicShare.ts";
import { pushRoutes } from "./push.ts";
import { searchRoutes } from "./search.ts";
import { streamRoute } from "./stream.ts";
import { tempRoutes } from "./temp.ts";
import { threadsRoutes } from "./threads.ts";
import { usersRoutes } from "./users.ts";

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

  // Bootstrap endpoints sit outside session middleware — they're how the
  // first admin is created when the DB has zero users.
  app.route("/api/bootstrap", bootstrapRoutes());

  // Public HTTP sign-up is closed via `disableSignUp: true` in auth.ts.
  // All account creation flows through /api/bootstrap (first admin) or
  // /api/users (admin-created) or /api/invites/accept (invited user).
  app.all("/api/auth/*", async (c) => {
    const auth = await authFromCtx(c);
    return auth.handler(c.req.raw);
  });

  app.use("/api/*", sessionMiddleware);

  app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

  app.get("/api/me", (c) => {
    const user = c.get("user");
    return c.json({ user });
  });

  app.route("/api/domains", domainsRoutes());
  app.route("/api/users", usersRoutes());
  app.route("/api/admin", adminRoutes());
  app.route("/api/mailboxes", mailboxesRoutes());
  app.route("/api/contacts", contactsRoutes());
  app.route("/api/threads", threadsRoutes());
  app.route("/api/drafts", draftsRoutes());
  app.route("/api/messages", messagesRoutes());
  app.route("/api/labels", labelsRoutes());
  app.route("/api/attachments", attachmentsRoutes());
  app.route("/api/temp", tempRoutes());
  app.route("/api/push", pushRoutes());
  app.route("/api/t", publicShareRoutes());
  app.route("/api/search", searchRoutes());
  app.get("/api/stream", streamRoute);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("unhandled", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
