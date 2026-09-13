import { folder, mailbox, message, thread, threadFolder } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
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

async function unreadOf(threadId: string): Promise<number> {
  const row = await db().query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { unreadCount: true },
  });
  return row?.unreadCount ?? -1;
}

async function seenFlags(threadId: string): Promise<boolean[]> {
  const rows = await db()
    .select({ flags: message.flags })
    .from(message)
    .where(eq(message.threadId, threadId));
  return rows.map((r) => (r.flags & Flag.SEEN) !== 0);
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

  it("narrows any view to unread threads with unread=1", async () => {
    const a = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const b = await seedMsgThread(db(), { direction: "in", unreadCount: 2 });
    const read = await seedMsgThread(db(), { direction: "in", flags: Flag.SEEN });

    const all = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=inbox`);
    const allBody = (await all.json()) as { threads: { id: string }[] };
    expect(allBody.threads.map((t) => t.id).toSorted()).toEqual(
      [a.threadId, b.threadId, read.threadId].toSorted(),
    );

    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}&view=inbox&unread=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: { id: string; unreadCount: number }[] };
    expect(body.threads.map((t) => t.id).toSorted()).toEqual([a.threadId, b.threadId].toSorted());
    for (const t of body.threads) expect(t.unreadCount).toBeGreaterThan(0);
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

  it("drops a mailbox opted out of All Mail from the combined view", async () => {
    const a = await seedMsgThread(db(), { mailboxId: MAILBOX_ID, direction: "in" });
    await seedMsgThread(db(), { mailboxId: OTHER_MAILBOX_ID, direction: "in" });
    await db()
      .update(mailbox)
      .set({ excludeFromAll: true })
      .where(eq(mailbox.id, OTHER_MAILBOX_ID));

    const all = await request(asOwner(), "GET", "/?mailboxId=all&view=all");
    const body = (await all.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([a.threadId]);

    // The mailbox itself is untouched — opened directly it still lists everything.
    const direct = await request(asOwner(), "GET", `/?mailboxId=${OTHER_MAILBOX_ID}&view=all`);
    expect(((await direct.json()) as { threads: unknown[] }).threads).toHaveLength(1);
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

  it("leaves a mailbox opted out of All Mail out of the combined counts", async () => {
    await seedMsgThread(db(), { mailboxId: MAILBOX_ID, direction: "in", unreadCount: 1 });
    await seedMsgThread(db(), { mailboxId: OTHER_MAILBOX_ID, direction: "in", unreadCount: 1 });
    await db()
      .update(mailbox)
      .set({ excludeFromAll: true })
      .where(eq(mailbox.id, OTHER_MAILBOX_ID));

    const res = await request(asOwner(), "GET", "/counts?mailboxId=all");
    const body = (await res.json()) as {
      counts: { inbox: { total: number; unread: number }; all: { total: number } };
    };
    expect(body.counts.inbox).toEqual({ total: 1, unread: 1 });
    expect(body.counts.all.total).toBe(1);
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

describe("mark all read", () => {
  it("marks every unread inbox thread read and leaves other views alone", async () => {
    const a = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const b = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const spam = await seedMsgThread(db(), { direction: "in", unreadCount: 1, spam: true });
    const trashed = await seedMsgThread(db(), { direction: "in", unreadCount: 1, trashed: true });
    const elsewhere = await seedMsgThread(db(), {
      direction: "in",
      unreadCount: 1,
      mailboxId: OTHER_MAILBOX_ID,
    });

    const res = await request(asOwner(), "POST", "/read-all", {
      mailboxId: MAILBOX_ID,
      view: "inbox",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: 2 });

    for (const { threadId } of [a, b]) {
      expect(await unreadOf(threadId)).toBe(0);
      expect(await seenFlags(threadId)).toEqual([true]);
    }
    for (const { threadId } of [spam, trashed, elsewhere]) {
      expect(await unreadOf(threadId)).toBe(1);
      expect(await seenFlags(threadId)).toEqual([false]);
    }

    // A second pass finds nothing left to flip.
    const again = await request(asOwner(), "POST", "/read-all", {
      mailboxId: MAILBOX_ID,
      view: "inbox",
    });
    expect(await again.json()).toEqual({ threads: 0 });
  });

  it("scopes to the requested view", async () => {
    const inbox = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const spam = await seedMsgThread(db(), { direction: "in", unreadCount: 1, spam: true });

    const res = await request(asOwner(), "POST", "/read-all", {
      mailboxId: MAILBOX_ID,
      view: "spam",
    });
    expect(await res.json()).toEqual({ threads: 1 });
    expect(await unreadOf(spam.threadId)).toBe(0);
    expect(await unreadOf(inbox.threadId)).toBe(1);
  });

  it("only flips inbound messages", async () => {
    const { threadId } = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    await db().insert(message).values({
      id: "m-out",
      mailboxId: MAILBOX_ID,
      threadId,
      direction: "out",
      fromAddr: "team@example.com",
      flags: Flag.SENT,
    });

    await request(asOwner(), "POST", "/read-all", { mailboxId: MAILBOX_ID, view: "inbox" });
    const rows = await db()
      .select({ id: message.id, flags: message.flags })
      .from(message)
      .where(eq(message.threadId, threadId));
    expect(rows.find((r) => r.id === "m-out")?.flags).toBe(Flag.SENT);
    expect(rows.filter((r) => r.id !== "m-out").every((r) => r.flags & Flag.SEEN)).toBe(true);
  });

  it("forbids a member without WRITE (403)", async () => {
    await grantMember(db(), Perm.READ);
    await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const res = await request(asMember(), "POST", "/read-all", {
      mailboxId: MAILBOX_ID,
      view: "inbox",
    });
    expect(res.status).toBe(403);
  });

  it("lets a member with WRITE mark all read", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const { threadId } = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const res = await request(asMember(), "POST", "/read-all", {
      mailboxId: MAILBOX_ID,
      view: "inbox",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: 1 });
    expect(await unreadOf(threadId)).toBe(0);
  });

  it("spans only writable mailboxes in the combined 'all' mailbox", async () => {
    await grantMember(db(), Perm.READ, MAILBOX_ID);
    await grantMember(db(), Perm.READ | Perm.WRITE, OTHER_MAILBOX_ID);
    const readable = await seedMsgThread(db(), { direction: "in", unreadCount: 1 });
    const writable = await seedMsgThread(db(), {
      direction: "in",
      unreadCount: 1,
      mailboxId: OTHER_MAILBOX_ID,
    });

    const res = await request(asMember(), "POST", "/read-all", { mailboxId: "all", view: "inbox" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: 1 });
    expect(await unreadOf(writable.threadId)).toBe(0);
    expect(await unreadOf(readable.threadId)).toBe(1);
  });

  it("rejects an unknown view via the validator", async () => {
    const res = await request(asOwner(), "POST", "/read-all", {
      mailboxId: MAILBOX_ID,
      view: "bogus",
    });
    expect(res.status).toBe(400);
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
