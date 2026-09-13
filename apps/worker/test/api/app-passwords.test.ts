import { appPassword } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appPasswordsRoutes } from "../../src/api/app-passwords.ts";
import { loginWithAppPassword, normalizeAppPassword } from "../../src/app-passwords.ts";
import { setConfig } from "../../src/config.ts";
import { AppError } from "../../src/errors.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

const asOwner = () => mountApp(appPasswordsRoutes, owner);

async function create(
  app = asOwner(),
  body: Record<string, unknown> = { mailboxId: MAILBOX_ID, name: "iPhone" },
) {
  const res = await request(app, "POST", "/", body);
  return { res, body: (await res.json()) as { id: string; password: string; username: string } };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("app passwords API", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(appPasswordsRoutes, null), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("creates a password once, stores only a hash, and lists it", async () => {
    const { res, body } = await create();
    expect(res.status).toBe(201);
    expect(body.password).toMatch(/^[a-z0-9]{5}(-[a-z0-9]{5}){3}$/);
    expect(body.username).toBe("team@example.com");
    const row = await db().query.appPassword.findFirst({ where: eq(appPassword.id, body.id) });
    expect(row!.hash).not.toContain(normalizeAppPassword(body.password));

    const list = await request(asOwner(), "GET", "/");
    const data = (await list.json()) as {
      passwords: { id: string; name: string; mailboxAddress: string; lastUsedAt: string | null }[];
      imap: { host: string; port: number } | null;
    };
    expect(data.passwords).toHaveLength(1);
    expect(data.passwords[0]).toMatchObject({
      id: body.id,
      name: "iPhone",
      mailboxAddress: "team@example.com",
      lastUsedAt: null,
    });
    expect(data.imap).toBeNull();

    await setConfig(db(), "imap_host", "imap.example.com");
    const withHost = (await (await request(asOwner(), "GET", "/")).json()) as {
      imap: { host: string; port: number } | null;
    };
    expect(withHost.imap).toEqual({ host: "imap.example.com", port: 993 });
  });

  it("requires READ on the mailbox and rejects service mailboxes", async () => {
    const denied = await request(mountApp(appPasswordsRoutes, outsider), "POST", "/", {
      mailboxId: MAILBOX_ID,
      name: "x",
    });
    expect(denied.status).toBe(403);
    await grantMember(db(), Perm.READ);
    const ok = await request(mountApp(appPasswordsRoutes, member), "POST", "/", {
      mailboxId: MAILBOX_ID,
      name: "x",
    });
    expect(ok.status).toBe(201);
    const missing = await request(asOwner(), "POST", "/", { mailboxId: "nope", name: "x" });
    expect(missing.status).toBe(403);
  });

  it("only the owner of a password can revoke it", async () => {
    const { body } = await create();
    await grantMember(db(), Perm.READ);
    const foreign = await request(mountApp(appPasswordsRoutes, member), "DELETE", `/${body.id}`);
    expect(foreign.status).toBe(404);
    const mine = await request(asOwner(), "DELETE", `/${body.id}`);
    expect(mine.status).toBe(204);
    expect(await db().query.appPassword.findMany()).toHaveLength(0);
  });

  it("caps the number of passwords per user", async () => {
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential inserts keep the cap check deterministic
      const { res } = await create(asOwner(), { mailboxId: MAILBOX_ID, name: `d${i}` });
      expect(res.status).toBe(201);
    }
    const { res } = await create(asOwner(), { mailboxId: OTHER_MAILBOX_ID, name: "one more" });
    expect(res.status).toBe(409);
  });
});

describe("loginWithAppPassword", () => {
  it("authenticates by mailbox address or sign-in email, ignoring dashes", async () => {
    const { body } = await create();
    const bare = body.password.replaceAll("-", "").toUpperCase();
    const a = await loginWithAppPassword(db(), "TEAM@example.com", bare, null);
    expect(a).toMatchObject({
      userId: owner.id,
      mailboxId: MAILBOX_ID,
      address: "team@example.com",
    });
    const b = await loginWithAppPassword(db(), owner.email, body.password, "10.0.0.1");
    expect(b?.mailboxId).toBe(MAILBOX_ID);
    const row = await db().query.appPassword.findFirst({ where: eq(appPassword.id, body.id) });
    expect(row!.lastUsedAt).not.toBeNull();
    expect(await loginWithAppPassword(db(), "team@example.com", "wrong", null)).toBeNull();
    expect(await loginWithAppPassword(db(), "nobody@example.com", body.password, null)).toBeNull();
  });

  it("throttles repeated failures per username", async () => {
    let err: unknown = null;
    for (let i = 0; i < 12 && !err; i++) {
      // eslint-disable-next-line no-await-in-loop -- counting attempts in order
      err = await loginWithAppPassword(db(), "team@example.com", "wrong", null).then(
        () => null,
        (x: unknown) => x,
      );
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("rate_limited");
  });
});
