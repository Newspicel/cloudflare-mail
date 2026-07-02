import type { MeUserDto } from "@cfmail/shared/responses";
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
import { remindersRoutes } from "./reminders.ts";
import { rulesRoutes } from "./rules.ts";
import { searchRoutes } from "./search.ts";
import { streamRoute } from "./stream.ts";
import { svcRoutes } from "./svc.ts";
import { tempRoutes } from "./temp.ts";
import { threadsRoutes } from "./threads.ts";
import { usersRoutes } from "./users.ts";

// Single chained expression: Hono RPC (`hc<AppType>` in the web app) can only
// infer the route schema when every registration flows through the chain.
export function buildApi() {
  const app = new Hono<AppBindings>()
    .use("*", logger())
    .use(
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
    )
    // Bootstrap endpoints sit outside session middleware — they're how the
    // first admin is created when the DB has zero users.
    .route("/api/bootstrap", bootstrapRoutes())
    // Service-mailbox API is bearer-key authed, not session authed — mount it
    // before the session middleware so it never touches cookies.
    .route("/api/svc", svcRoutes())
    // Public HTTP sign-up is closed via `disableSignUp: true` in auth.ts.
    // All account creation flows through /api/bootstrap (first admin) or
    // /api/users (admin-created) or /api/invites/accept (invited user).
    .all("/api/auth/*", async (c) => {
      const auth = await authFromCtx(c);
      return auth.handler(c.req.raw);
    })
    .use("/api/*", sessionMiddleware)
    .get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }))
    .get("/api/me", (c) => {
      // Better Auth's inferred session-user type drops plugin fields (role,
      // twoFactorEnabled) that the runtime object carries; MeUserDto is the
      // canonical wire shape, so surface it to the RPC client.
      const user = c.get("user") as MeUserDto | null;
      return c.json({ user });
    })
    .route("/api/domains", domainsRoutes())
    .route("/api/users", usersRoutes())
    .route("/api/admin", adminRoutes())
    .route("/api/admin/block", adminBlockRoutes())
    .route("/api/blocklist", blocklistRoutes())
    .route("/api/mailboxes", mailboxesRoutes())
    .route("/api/contacts", contactsRoutes())
    .route("/api/threads", threadsRoutes())
    .route("/api/drafts", draftsRoutes())
    .route("/api/messages", messagesRoutes())
    .route("/api/labels", labelsRoutes())
    .route("/api/folders", foldersRoutes())
    .route("/api/rules", rulesRoutes())
    .route("/api/attachments", attachmentsRoutes())
    .route("/api/avatar", avatarRoutes())
    .route("/api/temp", tempRoutes())
    .route("/api/push", pushRoutes())
    .route("/api/reminders", remindersRoutes())
    .route("/api/search", searchRoutes())
    .get("/api/stream", streamRoute);

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

// The composed route schema, consumed type-only by `hc<AppType>` in apps/web.
export type AppType = ReturnType<typeof buildApi>;
