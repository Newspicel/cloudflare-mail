import { account, user } from "@cfmail/db/schema";
import { bootstrapAdmin } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { hashPassword } from "better-auth/crypto";
import { count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authFromCtx } from "../auth-ctx.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";

export function bootstrapRoutes() {
  const r = new Hono<AppBindings>()

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const rows = await db.select({ n: count() }).from(user);
      const n = rows[0]?.n ?? 0;
      return c.json({ needsBootstrap: n === 0 });
    })

    .post("/", zValidator("json", bootstrapAdmin), async (c) => {
      const db = dbFromCtx(c);
      const body = c.req.valid("json");

      const email = body.email.toLowerCase();
      const userId = crypto.randomUUID();
      const accountId = crypto.randomUUID();
      const password = await hashPassword(body.password);

      // Atomic first-user claim: the row is written only if the table is still
      // empty, so two concurrent bootstraps can't both succeed. If we didn't
      // win the insert, someone else already bootstrapped.
      const claim = await db.run(
        sql`INSERT INTO "user" (id, name, email, email_verified, role)
          SELECT ${userId}, ${body.name}, ${email}, 1, 'admin'
          WHERE NOT EXISTS (SELECT 1 FROM "user")`,
      );
      if (claim.meta.changes === 0) {
        throw new HTTPException(409, { message: "already bootstrapped" });
      }
      await db.insert(account).values({
        id: accountId,
        userId,
        accountId: userId,
        providerId: "credential",
        password,
      });

      // Sign the new admin in immediately so the SPA can redirect to /app.
      const auth = await authFromCtx(c);
      const res = await auth.api.signInEmail({
        body: { email, password: body.password },
        asResponse: true,
        headers: c.req.raw.headers,
      });
      return res;
    });

  return r;
}

// Helper exported for /api/users and /api/invites/accept — both create a
// user + account pair the same way bootstrap does, just without the admin
// role.
export async function createUserWithPassword(
  db: ReturnType<typeof dbFromCtx>,
  input: { name: string; email: string; password: string; role: "admin" | "user" },
): Promise<{ id: string }> {
  const email = input.email.toLowerCase();
  const existing = await db.query.user.findFirst({
    where: eq(user.email, email),
    columns: { id: true },
  });
  if (existing) {
    throw new HTTPException(409, { message: "user exists" });
  }
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const password = await hashPassword(input.password);
  await db.insert(user).values({
    id: userId,
    name: input.name,
    email,
    emailVerified: true,
    role: input.role,
  });
  await db.insert(account).values({
    id: accountId,
    userId,
    accountId: userId,
    providerId: "credential",
    password,
  });
  return { id: userId };
}
