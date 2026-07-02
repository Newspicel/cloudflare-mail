import { mailboxInvite, mailboxMember } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mailboxesRoutes } from "../src/api/mailboxes.ts";
import { materializeInvites } from "../src/invites.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "./support/app.ts";
import {
  MAILBOX_ID,
  MEMBER_ID,
  member,
  OTHER_MAILBOX_ID,
  OWNER_ID,
  seedBase,
} from "./support/seed.ts";

async function seedInvite(
  overrides: Partial<typeof mailboxInvite.$inferInsert> = {},
): Promise<string> {
  const id = `invite-${crypto.randomUUID()}`;
  await db()
    .insert(mailboxInvite)
    .values({
      id,
      mailboxId: MAILBOX_ID,
      email: member.email,
      perms: Perm.READ,
      invitedByUserId: OWNER_ID,
      ...overrides,
    });
  return id;
}

async function membership(mailboxId = MAILBOX_ID, userId = MEMBER_ID) {
  return db().query.mailboxMember.findFirst({
    where: and(eq(mailboxMember.mailboxId, mailboxId), eq(mailboxMember.userId, userId)),
  });
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("materializeInvites", () => {
  it("turns a pending invite into a membership and consumes the invite", async () => {
    const id = await seedInvite();
    await materializeInvites(db(), MEMBER_ID, member.email);

    expect(await membership()).toMatchObject({ perms: Perm.READ });
    expect(
      await db().query.mailboxInvite.findFirst({ where: eq(mailboxInvite.id, id) }),
    ).toBeUndefined();
  });

  it("looks up the email from the user row when not passed (session-create path)", async () => {
    await seedInvite({ perms: Perm.READ | Perm.WRITE });
    await materializeInvites(db(), MEMBER_ID);
    expect(await membership()).toMatchObject({ perms: Perm.READ | Perm.WRITE });
  });

  it("matches the invite email case-insensitively", async () => {
    await seedInvite();
    await materializeInvites(db(), MEMBER_ID, "Member@Example.COM");
    expect(await membership()).toBeDefined();
  });

  it("materializes every pending invite for the address", async () => {
    await seedInvite();
    await seedInvite({ mailboxId: OTHER_MAILBOX_ID, perms: Perm.READ | Perm.WRITE });
    await materializeInvites(db(), MEMBER_ID, member.email);
    expect(await membership()).toBeDefined();
    expect(await membership(OTHER_MAILBOX_ID)).toMatchObject({ perms: Perm.READ | Perm.WRITE });
  });

  it("updates an existing membership's perms instead of failing", async () => {
    await db()
      .insert(mailboxMember)
      .values({ mailboxId: MAILBOX_ID, userId: MEMBER_ID, perms: Perm.READ });
    await seedInvite({ perms: Perm.READ | Perm.WRITE | Perm.MANAGE });
    await materializeInvites(db(), MEMBER_ID, member.email);
    expect(await membership()).toMatchObject({ perms: Perm.READ | Perm.WRITE | Perm.MANAGE });
  });

  it("is a no-op when there are no pending invites", async () => {
    await materializeInvites(db(), MEMBER_ID, member.email);
    expect(await membership()).toBeUndefined();
  });
});

describe("GET /mailboxes materializes pending invites", () => {
  it("the invited mailbox appears in the listing on first fetch", async () => {
    await seedInvite({ perms: Perm.READ | Perm.WRITE });
    const res = await request(mountApp(mailboxesRoutes, member), "GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: { id: string; role: string; perms: number }[];
    };
    expect(body.mailboxes).toHaveLength(1);
    expect(body.mailboxes[0]).toMatchObject({
      id: MAILBOX_ID,
      role: "member",
      perms: Perm.READ | Perm.WRITE,
    });
    // The invite was consumed into a real membership row.
    expect(await membership()).toBeDefined();
    expect(await db().query.mailboxInvite.findMany()).toHaveLength(0);
  });
});
