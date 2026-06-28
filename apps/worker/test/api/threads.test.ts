import { folder, message, thread, threadFolder } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { threadsRoutes } from "../../src/api/threads.ts";
import { applyMigrationsOnce, type DB, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

const asOwner = () => mountApp(threadsRoutes, owner);
const asMember = () => mountApp(threadsRoutes, member);
const asOutsider = () => mountApp(threadsRoutes, outsider);

// seedThread in support/ stores `direction: "inbound"`, which never matches the
// route's `"in"`/`"out"` view filters. These local helpers insert rows with the
// real enum values plus full control over flags / timestamps / bucket state.
let seq = 0;

interface ThreadOpts {
  mailboxId?: string;
  direction?: "in" | "out";
  flags?: number;
  trashed?: boolean;
  spam?: boolean;
  unreadCount?: number;
  lastMsgAt?: Date;
}

async function seedMsgThread(
  database: DB,
  opts: ThreadOpts = {},
): Promise<{ threadId: string; messageId: string }> {
  const n = ++seq;
  const threadId = `th-${n}`;
  const messageId = `m-${n}`;
  const mailboxId = opts.mailboxId ?? MAILBOX_ID;
  await database.insert(thread).values({
    id: threadId,
    mailboxId,
    subjectNorm: "subject",
    msgCount: 1,
    unreadCount: opts.unreadCount ?? 0,
    trashed: opts.trashed ?? false,
    spam: opts.spam ?? false,
    ...(opts.lastMsgAt ? { lastMsgAt: opts.lastMsgAt } : {}),
  });
  await database.insert(message).values({
    id: messageId,
    mailboxId,
    threadId,
    direction: opts.direction ?? "in",
    fromAddr: "sender@elsewhere.test",
    fromName: "Sender",
    subject: "Hello",
    snippet: "Hello there",
    flags: opts.flags ?? 0,
  });
  return { threadId, messageId };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("threads list", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(mountApp(threadsRoutes, null), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(401);
  });

  it("requires mailboxId", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(400);
  });

  it("forbids an outsider from listing a mailbox (403)", async () => {
    const res = await request(asOutsider(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  it("returns inbound threads in the default inbox view", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: { id: string }[]; nextCursor: string | null };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);
    expect(body.nextCursor).toBeNull();
  });

  it("hides a thread filed into a folder from the inbox view", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    await db().insert(folder).values({ id: "fold-1", userId: OWNER_ID, name: "Filed" });
    await db().insert(threadFolder).values({ threadId, userId: OWNER_ID, folderId: "fold-1" });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    const body = (await res.json()) as { threads: unknown[] };
    expect(body.threads).toHaveLength(0);
  });

  it("filters the sent view to outbound messages", async () => {
    await seedMsgThread(db(), { direction: "in" });
    const { threadId } = await seedMsgThread(db(), { direction: "out" });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=sent`);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);
  });

  it("filters the marked view to starred messages", async () => {
    await seedMsgThread(db(), { direction: "in" });
    const { threadId } = await seedMsgThread(db(), { direction: "in", flags: Flag.STARRED });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=marked`);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);
  });

  it("filters the spam view to spam threads", async () => {
    await seedMsgThread(db(), { direction: "in" });
    const { threadId } = await seedMsgThread(db(), { direction: "in", spam: true });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=spam`);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);
  });

  it("filters the trash view to trashed threads", async () => {
    await seedMsgThread(db(), { direction: "in" });
    const { threadId } = await seedMsgThread(db(), { direction: "in", trashed: true });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=trash`);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);
  });

  it("surfaces a live thread holding an individually-trashed message in trash", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in", flags: Flag.TRASH });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=trash`);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);
  });

  it("returns every thread in the 'all' view regardless of bucket", async () => {
    await seedMsgThread(db(), { direction: "in" });
    await seedMsgThread(db(), { direction: "in", trashed: true });
    await seedMsgThread(db(), { direction: "in", spam: true });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=all`);
    const body = (await res.json()) as { threads: unknown[] };
    expect(body.threads).toHaveLength(3);
  });

  it("spans accessible mailboxes in the combined 'all' mailbox view", async () => {
    const a = await seedMsgThread(db(), { mailboxId: MAILBOX_ID, direction: "in" });
    const b = await seedMsgThread(db(), { mailboxId: OTHER_MAILBOX_ID, direction: "in" });
    const res = await request(asOwner(), "GET", "/?mailboxId=all&view=all");
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id).toSorted()).toEqual([a.threadId, b.threadId].toSorted());
  });

  it("returns an empty list for the 'all' view when the user can read nothing", async () => {
    await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOutsider(), "GET", "/?mailboxId=all");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [] });
  });

  it("paginates with a keyset cursor", async () => {
    const t1 = await seedMsgThread(db(), { lastMsgAt: new Date(1_000_000) });
    const t2 = await seedMsgThread(db(), { lastMsgAt: new Date(2_000_000) });
    const t3 = await seedMsgThread(db(), { lastMsgAt: new Date(3_000_000) });

    const page1 = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=all&limit=2`);
    const b1 = (await page1.json()) as { threads: { id: string }[]; nextCursor: string | null };
    expect(b1.threads.map((t) => t.id)).toEqual([t3.threadId, t2.threadId]);
    expect(b1.nextCursor).not.toBeNull();

    const page2 = await request(
      asOwner(),
      "GET",
      `/?mailboxId=${MAILBOX_ID}&view=all&limit=2&cursor=${encodeURIComponent(b1.nextCursor!)}`,
    );
    const b2 = (await page2.json()) as { threads: { id: string }[]; nextCursor: string | null };
    expect(b2.threads.map((t) => t.id)).toEqual([t1.threadId]);
    expect(b2.nextCursor).toBeNull();
  });

  it("lets a member with READ list", async () => {
    await grantMember(db(), Perm.READ);
    await seedMsgThread(db(), { direction: "in" });
    const res = await request(asMember(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
  });
});

describe("thread counts", () => {
  it("requires mailboxId", async () => {
    const res = await request(asOwner(), "GET", "/counts");
    expect(res.status).toBe(400);
  });

  it("forbids an outsider (403)", async () => {
    const res = await request(asOutsider(), "GET", `/counts?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  it("reports per-folder badge counts", async () => {
    await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    await seedMsgThread(db(), { direction: "out" });
    await seedMsgThread(db(), { direction: "in", spam: true });
    await seedMsgThread(db(), { direction: "in", trashed: true });

    const res = await request(asOwner(), "GET", `/counts?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: {
        inbox: { total: number; unread: number };
        sent: { total: number };
        spam: { total: number };
        trash: { total: number };
        all: { total: number };
      };
    };
    expect(body.counts.inbox).toEqual({ total: 1, unread: 1 });
    expect(body.counts.sent.total).toBe(1);
    expect(body.counts.spam.total).toBe(1);
    expect(body.counts.trash.total).toBe(1);
    expect(body.counts.all.total).toBe(4);
  });

  it("returns zeroed counts for the 'all' view with no accessible mailboxes", async () => {
    const res = await request(asOutsider(), "GET", "/counts?mailboxId=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: { all: { total: number } } };
    expect(body.counts.all.total).toBe(0);
  });
});

describe("thread detail", () => {
  it("returns a thread with its messages", async () => {
    const { threadId, messageId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOwner(), "GET", `/${threadId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thread: { id: string };
      messages: { id: string }[];
    };
    expect(body.thread.id).toBe(threadId);
    expect(body.messages.map((m) => m.id)).toEqual([messageId]);
  });

  it("404s a missing thread", async () => {
    const res = await request(asOwner(), "GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("forbids an outsider from a cross-mailbox thread (403)", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOutsider(), "GET", `/${threadId}`);
    expect(res.status).toBe(403);
  });
});

describe("thread summary", () => {
  it("403s when AI features are off for the mailbox", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOwner(), "POST", `/${threadId}/summary`);
    expect(res.status).toBe(403);
  });

  it("404s a missing thread", async () => {
    const res = await request(asOwner(), "POST", "/nope/summary");
    expect(res.status).toBe(404);
  });
});

describe("thread mutations", () => {
  it("rejects an invalid patch body via the validator", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOwner(), "PATCH", `/${threadId}`, { trashed: "yes" });
    expect(res.status).toBe(400);
  });

  it("404s patching a missing thread", async () => {
    const res = await request(asOwner(), "PATCH", "/nope", { trashed: true });
    expect(res.status).toBe(404);
  });

  it("forbids a member without WRITE from patching (403)", async () => {
    await grantMember(db(), Perm.READ);
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asMember(), "PATCH", `/${threadId}`, { trashed: true });
    expect(res.status).toBe(403);
  });

  it("trashes a thread and clears spam", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in", spam: true });
    const res = await request(asOwner(), "PATCH", `/${threadId}`, { trashed: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trashed: boolean; spam: boolean };
    expect(body).toMatchObject({ trashed: true, spam: false });
  });

  it("untrashes a thread", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in", trashed: true });
    const res = await request(asOwner(), "PATCH", `/${threadId}`, { trashed: false });
    const body = (await res.json()) as { trashed: boolean };
    expect(body.trashed).toBe(false);
  });

  it("marks a thread as spam and clears trash", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in", trashed: true });
    const res = await request(asOwner(), "PATCH", `/${threadId}`, { spam: true });
    const body = (await res.json()) as { trashed: boolean; spam: boolean };
    expect(body).toMatchObject({ trashed: false, spam: true });
  });

  it("marks a thread read, zeroing the unread count", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const res = await request(asOwner(), "PATCH", `/${threadId}`, { read: true });
    const body = (await res.json()) as { unreadCount: number };
    expect(body.unreadCount).toBe(0);
  });

  it("lets a member with WRITE patch", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asMember(), "PATCH", `/${threadId}`, { trashed: true });
    expect(res.status).toBe(200);
  });
});

describe("thread delete", () => {
  it("permanently deletes a thread", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asOwner(), "DELETE", `/${threadId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const after = await request(asOwner(), "GET", `/${threadId}`);
    expect(after.status).toBe(404);
  });

  it("404s deleting a missing thread", async () => {
    const res = await request(asOwner(), "DELETE", "/nope");
    expect(res.status).toBe(404);
  });

  it("forbids a member without WRITE from deleting (403)", async () => {
    await grantMember(db(), Perm.READ);
    const { threadId } = await seedMsgThread(db(), { direction: "in" });
    const res = await request(asMember(), "DELETE", `/${threadId}`);
    expect(res.status).toBe(403);
  });
});
