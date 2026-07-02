import { passkey } from "@better-auth/passkey";
import { type DB, makeDB, schema } from "@cfmail/db";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getConfig, getOrCreateAuthSecret } from "./config.ts";
import type { Env } from "./env.ts";
import { materializeInvites } from "./invites.ts";
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

// App preferences ride on the session user so /api/me returns them and
// authClient.updateUser persists them. Value is a JSON string (UserPrefs).
export const userAdditionalFields = {
  preferences: { type: "string", required: false, input: true },
} as const;

// The Better Auth plugin list. Kept here (not inlined below) so the schema
// drift test can ask Better Auth for the exact tables/columns these plugins
// require and diff them against schema.ts. This is the single source of truth.
export function authPlugins(baseURL: string) {
  return [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    twoFactor(),
    // rpID/origin derive from the request-scoped baseURL (no hardcoded host),
    // so passkeys bind to whatever domain the deployment is served on.
    passkey({
      rpID: new URL(baseURL).hostname,
      rpName: "cfmail",
      origin: baseURL,
    }),
  ];
}

export async function createAuth({ env, db, baseURL }: CreateAuthOpts) {
  const database = db ?? makeDB(env.DB);
  const secret = await getOrCreateAuthSecret(database);

  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    // Off at runtime; the bundle drop happens via the semantic-conventions
    // shim alias in wrangler.jsonc (the flag alone doesn't tree-shake it).
    telemetry: { enabled: false },
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        passkey: schema.passkey,
        rateLimit: schema.rateLimit,
      },
      usePlural: false,
    }),
    // Brute-force protection for login/2FA/password-reset. Database storage —
    // Workers isolates have no shared memory, so counters must live in D1.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
      },
    },
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
    // Only reachable via the change-email flow below: sign-up is closed and
    // all accounts are created pre-verified, so plain verify-email never runs.
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        const from = await getConfig(database, "auth_from_address");
        if (!from) return;
        await sendMail(env, {
          from,
          to: user.email,
          subject: "Confirm your new email address",
          text:
            `A request was made to use this address for your account.\n\n` +
            `Confirm the change:\n${url}\n\n` +
            `If you didn't request this, ignore this email.`,
        });
      },
    },
    user: {
      additionalFields: userAdditionalFields,
      // Sends the confirmation link to the NEW address (accounts are always
      // email-verified); the email only changes once that link is clicked.
      changeEmail: { enabled: true },
    },
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { sameSite: "lax" },
      // Cloudflare's canonical client-IP header, so rate-limit buckets key on
      // the real client rather than an easily spoofed X-Forwarded-For.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    databaseHooks: {
      session: {
        create: {
          // Materialize pending mailbox invites at login instead of on every
          // request (the mailbox list also runs this for long-lived sessions).
          after: async (session) => {
            await materializeInvites(database, session.userId).catch((err) =>
              console.error("invite materialization failed", err),
            );
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Serve the session from a signed cookie to skip the per-request D1
      // read. Short TTL so admin bans / role changes still take effect fast.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    plugins: authPlugins(baseURL),
  });
}

export function baseUrlFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
