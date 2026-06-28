import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { remindersRoutes } from "../../src/api/reminders.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(remindersRoutes, owner);

const future = () => Date.now() + 86_400_000;

async function create(
  app: ReturnType<typeof asOwner>,
  threadId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; id?: string }> {
  const res = await request(app, "POST", "/", {
    mailboxId: MAILBOX_ID,
    threadId,
    remindAt: future(),
    ...extra,
  });
  if (res.status !== 201) return { status: res.status };
  const body = (await res.json()) as { reminder: { id: string } };
  return { status: res.status, id: body.reminder.id };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("reminders", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(remindersRoutes, null), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("creates a reminder, snapshotting the thread subject", async () => {
    const { threadId } = await seedThread(db());
    const { status, id } = await create(asOwner(), threadId);
    expect(status).toBe(201);
    expect(id).toBeTruthy();

    const list = await request(asOwner(), "GET", "/");
    const body = (await list.json()) as { reminders: { id: string; subject: string }[] };
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]?.subject).toBe("Hello");
  });

  it("validates the body", async () => {
    const res = await request(asOwner(), "POST", "/", { mailboxId: MAILBOX_ID });
    expect(res.status).toBe(400);
  });

  it("forbids creating against a mailbox the user can't read", async () => {
    const { threadId } = await seedThread(db());
    const res = await request(mountApp(remindersRoutes, outsider), "POST", "/", {
      mailboxId: MAILBOX_ID,
      threadId,
      remindAt: future(),
    });
    expect(res.status).toBe(403);
  });

  it("lets a member with READ create one", async () => {
    await grantMember(db(), Perm.READ);
    const { threadId } = await seedThread(db());
    const { status } = await create(mountApp(remindersRoutes, member), threadId);
    expect(status).toBe(201);
  });

  it("only lists the caller's own reminders", async () => {
    await grantMember(db(), Perm.READ);
    const { threadId } = await seedThread(db());
    await create(asOwner(), threadId);

    const memberList = await request(mountApp(remindersRoutes, member), "GET", "/");
    const body = (await memberList.json()) as { reminders: unknown[] };
    expect(body.reminders).toHaveLength(0);
  });

  it("dismisses a reminder via status=done", async () => {
    const { threadId } = await seedThread(db());
    const { id } = await create(asOwner(), threadId);
    const res = await request(asOwner(), "PATCH", `/${id}`, { status: "done" });
    expect(res.status).toBe(200);

    // Done reminders drop out of the live feed.
    const list = await request(asOwner(), "GET", "/");
    expect(((await list.json()) as { reminders: unknown[] }).reminders).toHaveLength(0);
  });

  it("404s patching someone else's reminder", async () => {
    const { threadId } = await seedThread(db());
    const { id } = await create(asOwner(), threadId);
    const res = await request(mountApp(remindersRoutes, outsider), "PATCH", `/${id}`, {
      status: "done",
    });
    expect(res.status).toBe(404);
  });

  it("deletes own reminder; 404 on a missing one", async () => {
    const { threadId } = await seedThread(db());
    const { id } = await create(asOwner(), threadId);
    expect((await request(asOwner(), "DELETE", `/${id}`)).status).toBe(204);
    expect((await request(asOwner(), "DELETE", `/${id}`)).status).toBe(404);
  });
});
