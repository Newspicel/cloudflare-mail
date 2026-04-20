import { makeDB, schema } from "@cfmail/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Env } from "./env.ts";

export function createAuth(env: Env) {
  const db = makeDB(env.DB);
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET ?? "dev-secret-change-me",
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
      usePlural: false,
    }),
    emailAndPassword: { enabled: true, autoSignIn: true },
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { sameSite: "lax" },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type User =
  Awaited<ReturnType<Auth["api"]["getSession"]>> extends infer S | null | undefined
    ? S extends { user: infer U }
      ? U
      : never
    : never;
