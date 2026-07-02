import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, Env } from "../../src/env.ts";

export const e = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

export type DB = ReturnType<typeof makeDB>;

export function db(): DB {
  return makeDB(e.DB);
}

// Minimal session user. Routes only read `id`, `email`, `role` off the session
// user, so we don't need the full Better Auth shape.
export interface TestUser {
  id: string;
  email: string;
  role?: "admin" | "user";
  name?: string;
}

// Mount a route sub-app behind a middleware that injects `db` + `user` straight
// onto the Hono context — the same vars `sessionMiddleware` would set, but with
// no Better Auth round-trip. This exercises the real handlers, validators and
// RBAC against a real D1 while keeping auth a one-line fixture.
export function mountApp(
  routes: () => Hono<AppBindings>,
  user: TestUser | null = null,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("db", makeDB(c.env.DB));
    // biome-ignore lint/suspicious/noExplicitAny: test session user is a subset.
    c.set("user", (user as any) ?? null);
    c.set("baseUrl", "https://mail.test");
    await next();
  });
  app.route("/", routes());
  // Mirror the production error shape (see api/index.ts) so tests can assert on
  // `{ error }` bodies and status codes uniformly.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.getResponse();
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}

// Fire a request at a mounted test app. Body is JSON-encoded when an object is
// given; pass a string/undefined through untouched.
export function request(
  app: Hono<AppBindings>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return Promise.resolve(app.request(path, init, e as unknown as Env));
}

let migrated = false;

// Apply migrations once per worker, then truncate app tables before each test so
// suites stay isolated without paying for a fresh DB each time.
export async function applyMigrationsOnce(): Promise<void> {
  if (migrated) return;
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  migrated = true;
}

// Order matters: children before parents to respect FKs. Better Auth tables are
// left alone — tests seed `user` directly and never touch sessions.
const TRUNCATE_TABLES = [
  "rate_limit",
  "rate_limit_counter",
  "reminder",
  "block_request",
  "blocklist",
  "rule_send_log",
  "rule",
  "thread_folder",
  "folder",
  "message_label",
  "label",
  "draft",
  "attachment",
  "thread_summary",
  "message",
  "thread",
  "contact_key",
  "mailbox_notify",
  "push_subscription",
  "mailbox_invite",
  "mailbox_member",
  "redirect",
  "mailbox",
  "domain_grant",
  "domain",
  "user_invite",
  "user",
];

export async function resetDb(): Promise<void> {
  await e.DB.batch(TRUNCATE_TABLES.map((t) => e.DB.prepare(`DELETE FROM ${t}`)));
}
