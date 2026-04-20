import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { domain, mailbox, mailboxMember, user } from "@cfmail/db/schema";
import { ALL_PERMS, Perm } from "@cfmail/shared/permissions";
import { HTTPException } from "hono/http-exception";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { requirePerm, resolveAccess } from "../src/permissions.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const MEMBER_ID = "user-member";
const OUTSIDER_ID = "user-outsider";
const DOMAIN_ID = "domain-1";
const MAILBOX_ID = "mailbox-1";
const SERVICE_MAILBOX_ID = "mailbox-service";

async function seed(): Promise<void> {
  await db.insert(user).values([
    { id: OWNER_ID, name: "Owner", email: "owner@example.com" },
    { id: MEMBER_ID, name: "Member", email: "member@example.com" },
    { id: OUTSIDER_ID, name: "Outsider", email: "outsider@example.com" },
  ]);
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com", kind: "primary" });
  await db.insert(mailbox).values([
    {
      id: MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "team",
      type: "group",
      ownerUserId: OWNER_ID,
    },
    {
      id: SERVICE_MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "no-reply",
      type: "service",
      ownerUserId: OWNER_ID,
    },
  ]);
}

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM mailbox_member"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
}

async function grantMember(mailboxId: string, perms: number): Promise<void> {
  await db.insert(mailboxMember).values({ mailboxId, userId: MEMBER_ID, perms });
}

async function expectForbidden(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status: 403 });
  await expect(promise).rejects.toBeInstanceOf(HTTPException);
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("resolveAccess", () => {
  it("returns owner with ALL_PERMS and isOwner=true", async () => {
    const access = await resolveAccess(db, OWNER_ID, MAILBOX_ID);
    expect(access).toEqual({
      mailboxId: MAILBOX_ID,
      userId: OWNER_ID,
      perms: ALL_PERMS,
      isOwner: true,
    });
  });

  it("returns member with granted bits and isOwner=false", async () => {
    await grantMember(MAILBOX_ID, Perm.READ | Perm.WRITE);
    const access = await resolveAccess(db, MEMBER_ID, MAILBOX_ID);
    expect(access).toEqual({
      mailboxId: MAILBOX_ID,
      userId: MEMBER_ID,
      perms: Perm.READ | Perm.WRITE,
      isOwner: false,
    });
  });

  it("returns null for non-member, non-owner", async () => {
    const access = await resolveAccess(db, OUTSIDER_ID, MAILBOX_ID);
    expect(access).toBeNull();
  });

  it("returns null for missing mailbox", async () => {
    const access = await resolveAccess(db, OWNER_ID, "does-not-exist");
    expect(access).toBeNull();
  });
});

describe("requirePerm — owner bypass", () => {
  it("allows every bit for the owner", async () => {
    await expect(requirePerm(db, OWNER_ID, MAILBOX_ID, Perm.READ)).resolves.toMatchObject({
      isOwner: true,
    });
    await expect(requirePerm(db, OWNER_ID, MAILBOX_ID, Perm.WRITE)).resolves.toMatchObject({
      isOwner: true,
    });
    await expect(requirePerm(db, OWNER_ID, MAILBOX_ID, Perm.MANAGE)).resolves.toMatchObject({
      isOwner: true,
    });
  });

  it("owner bypass applies to service mailboxes too", async () => {
    await expect(requirePerm(db, OWNER_ID, SERVICE_MAILBOX_ID, Perm.WRITE)).resolves.toMatchObject({
      isOwner: true,
    });
  });
});

describe("requirePerm — member grants", () => {
  it("READ-only member: READ passes, WRITE and MANAGE are forbidden", async () => {
    await grantMember(MAILBOX_ID, Perm.READ);
    await expect(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.READ)).resolves.toMatchObject({
      isOwner: false,
      perms: Perm.READ,
    });
    await expectForbidden(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.WRITE));
    await expectForbidden(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.MANAGE));
  });

  it("READ+WRITE member: MANAGE is forbidden", async () => {
    await grantMember(MAILBOX_ID, Perm.READ | Perm.WRITE);
    await expect(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.WRITE)).resolves.toBeDefined();
    await expectForbidden(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.MANAGE));
  });

  it("zero-perm member is denied every bit", async () => {
    await grantMember(MAILBOX_ID, 0);
    await expectForbidden(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.READ));
    await expectForbidden(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.WRITE));
    await expectForbidden(requirePerm(db, MEMBER_ID, MAILBOX_ID, Perm.MANAGE));
  });
});

describe("requirePerm — denial paths", () => {
  it("non-member is forbidden even if mailbox exists", async () => {
    await expectForbidden(requirePerm(db, OUTSIDER_ID, MAILBOX_ID, Perm.READ));
  });

  it("missing mailbox is forbidden (not a 404)", async () => {
    await expectForbidden(requirePerm(db, OWNER_ID, "does-not-exist", Perm.READ));
  });
});

describe("requirePerm — service mailbox write-only member", () => {
  it("a WRITE-only member on a service mailbox can WRITE but not READ or MANAGE", async () => {
    await grantMember(SERVICE_MAILBOX_ID, Perm.WRITE);
    await expect(requirePerm(db, MEMBER_ID, SERVICE_MAILBOX_ID, Perm.WRITE)).resolves.toMatchObject(
      { perms: Perm.WRITE },
    );
    await expectForbidden(requirePerm(db, MEMBER_ID, SERVICE_MAILBOX_ID, Perm.READ));
    await expectForbidden(requirePerm(db, MEMBER_ID, SERVICE_MAILBOX_ID, Perm.MANAGE));
  });
});
