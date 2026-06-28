import { user } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapRoutes } from "../../src/api/bootstrap.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { seedBase } from "../support/seed.ts";

// bootstrap.ts has no session middleware — it gates purely on the user table
// being empty, so we mount with a null session user.
const app = () => mountApp(bootstrapRoutes, null);

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
});

describe("bootstrap", () => {
  it("reports needsBootstrap=true when no users exist", async () => {
    const res = await request(app(), "GET", "/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsBootstrap: true });
  });

  it("reports needsBootstrap=false once a user exists", async () => {
    await seedBase(db());
    const res = await request(app(), "GET", "/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsBootstrap: false });
  });

  it("rejects an invalid body with 400", async () => {
    // password too short (min 8) — fails the zod validator.
    const res = await request(app(), "POST", "/", {
      email: "first@example.com",
      name: "First Admin",
      password: "short",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed email with 400", async () => {
    const res = await request(app(), "POST", "/", {
      email: "not-an-email",
      name: "First Admin",
      password: "longenough123",
    });
    expect(res.status).toBe(400);
  });

  it("refuses to bootstrap when users already exist (409)", async () => {
    await seedBase(db());
    const res = await request(app(), "POST", "/", {
      email: "first@example.com",
      name: "First Admin",
      password: "longenough123",
    });
    expect(res.status).toBe(409);
  });

  it("creates the first admin (and signs them in) when the table is empty", async () => {
    const res = await request(app(), "POST", "/", {
      email: "First@Example.com",
      name: "First Admin",
      password: "longenough123",
    });
    // signInEmail returns a 200 response with a session cookie.
    expect(res.status).toBe(200);

    const row = await db().query.user.findFirst({
      where: eq(user.email, "first@example.com"),
      columns: { role: true, emailVerified: true, name: true },
    });
    expect(row?.role).toBe("admin");
    expect(row?.emailVerified).toBe(true);
    expect(row?.name).toBe("First Admin");

    // A second bootstrap now refuses.
    const again = await request(app(), "POST", "/", {
      email: "second@example.com",
      name: "Second",
      password: "longenough123",
    });
    expect(again.status).toBe(409);
  });

  it("needsBootstrap flips to false after a successful bootstrap", async () => {
    await request(app(), "POST", "/", {
      email: "first@example.com",
      name: "First Admin",
      password: "longenough123",
    });
    const res = await request(app(), "GET", "/");
    expect(await res.json()).toEqual({ needsBootstrap: false });
  });
});
