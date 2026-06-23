import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { authFromCtx } from "../auth-ctx.ts";
import type { AppBindings } from "../env.ts";
import { sessionMiddleware } from "../middleware.ts";
import { adminRoutes } from "./admin.ts";
import { adminBlockRoutes } from "./admin-block.ts";
import { attachmentsRoutes } from "./attachments.ts";
import { avatarRoutes } from "./avatar.ts";
import { blocklistRoutes } from "./blocklist.ts";
import { bootstrapRoutes } from "./bootstrap.ts";
import { contactsRoutes } from "./contacts.ts";
import { domainsRoutes } from "./domains.ts";
import { draftsRoutes } from "./drafts.ts";
import { foldersRoutes } from "./folders.ts";
import { labelsRoutes } from "./labels.ts";
import { mailboxesRoutes } from "./mailboxes.ts";
import { messagesRoutes } from "./messages.ts";
import { pushRoutes } from "./push.ts";
import { rulesRoutes } from "./rules.ts";
import { searchRoutes } from "./search.ts";
import { streamRoute } from "./stream.ts";
import { svcRoutes } from "./svc.ts";
import { tempRoutes } from "./temp.ts";
import { threadsRoutes } from "./threads.ts";
import { usersRoutes } from "./users.ts";

export function buildApi() {
  const app = new Hono<AppBindings>();

  app.use("*", logger());
  app.use(
    "/api/*",
    cors({
      // Web app and API are one Worker on one origin, so the only legitimate
      // credentialed caller is the instance's own origin. Reflect the Origin
      // only when it matches; otherwise send no CORS headers.
      origin: (o, c) => {
        const self = new URL(c.req.url).origin;
        return o === self ? o : null;
      },
      credentials: true,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Bootstrap endpoints sit outside session middleware — they're how the
  // first admin is created when the DB has zero users.
  app.route("/api/bootstrap", bootstrapRoutes());

  // Service-mailbox API is bearer-key authed, not session authed — mount it
  // before the session middleware so it never touches cookies.
  app.route("/api/svc", svcRoutes());

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
  app.route("/api/admin/block", adminBlockRoutes());
  app.route("/api/blocklist", blocklistRoutes());
  app.route("/api/mailboxes", mailboxesRoutes());
  app.route("/api/contacts", contactsRoutes());
  app.route("/api/threads", threadsRoutes());
  app.route("/api/drafts", draftsRoutes());
  app.route("/api/messages", messagesRoutes());
  app.route("/api/labels", labelsRoutes());
  app.route("/api/folders", foldersRoutes());
  app.route("/api/rules", rulesRoutes());
  app.route("/api/attachments", attachmentsRoutes());
  app.route("/api/avatar", avatarRoutes());
  app.route("/api/temp", tempRoutes());
  app.route("/api/push", pushRoutes());
  app.route("/api/search", searchRoutes());
  app.get("/api/stream", streamRoute);

  // One error shape everywhere: `{ error }`. HTTPExceptions carrying their own
  // response (e.g. zValidator) keep it; the rest become JSON so clients never
  // have to special-case a plain-text body.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.getResponse();
      return c.json({ error: err.message }, err.status);
    }
    console.error("unhandled", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
