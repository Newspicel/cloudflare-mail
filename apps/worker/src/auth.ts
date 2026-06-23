import { type DB, makeDB, schema } from "@cfmail/db";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getConfig, getOrCreateAuthSecret } from "./config.ts";
import type { Env } from "./env.ts";
import { sendMail } from "./mail/notify.ts";

export type Auth = Awaited<ReturnType<typeof createAuth>>;
export type User =
  Awaited<ReturnType<Auth["api"]["getSession"]>> extends infer S | null | undefined
    ? S extends { user: infer U }
      ? U
      : never
    : never;

interface CreateAuthOpts {
  env: Env;
  db?: DB;
  baseURL: string;
}

export async function createAuth({ env, db, baseURL }: CreateAuthOpts) {
  const database = db ?? makeDB(env.DB);
  const secret = await getOrCreateAuthSecret(database);

  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
      },
      usePlural: false,
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      // Public HTTP sign-up is blocked at the Hono layer (api/index.ts).
      // Bootstrap + admin-created users + invite acceptance call
      // auth.api.signUpEmail internally, which is unaffected by this flag.
      disableSignUp: true,
      sendResetPassword: async ({ user, url }) => {
        // Admins cannot use the self-service reset flow — they must recover
        // via 2FA backup codes or a CLI `wrangler d1 execute` reset.
        const u = user as { email: string; role?: string };
        if (u.role === "admin") return;
        const from = await getConfig(database, "auth_from_address");
        if (!from) return;
        await sendMail(env, {
          from,
          to: u.email,
          subject: "Reset your password",
          text:
            `A password reset was requested for your account.\n\n` +
            `Reset link (valid 1 hour):\n${url}\n\n` +
            `If you didn't request this, ignore this email.`,
        });
      },
      resetPasswordTokenExpiresIn: 3600,
    },
    user: {
      // App preferences ride on the session user so /api/me returns them and
      // authClient.updateUser persists them. Value is a JSON string (UserPrefs).
      additionalFields: {
        preferences: { type: "string", required: false, input: true },
      },
    },
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { sameSite: "lax" },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Serve the session from a signed cookie to skip the per-request D1
      // read. Short TTL so admin bans / role changes still take effect fast.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    plugins: [
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      twoFactor(),
    ],
  });
}

export function baseUrlFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
