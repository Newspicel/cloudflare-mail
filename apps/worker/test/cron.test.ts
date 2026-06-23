import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { attachment, domain, mailbox, message, thread, user } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import type { Env } from "../src/env.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const EXPIRED_ID = "mailbox-expired";
const FRESH_ID = "mailbox-fresh";
const PERSONAL_ID = "mailbox-personal";

const EXPIRED_RAW = `raw/${EXPIRED_ID}/msg-1.eml`;
const EXPIRED_ATT = `att/msg-1/0-file.txt`;
const FRESH_RAW = `raw/${FRESH_ID}/msg-2.eml`;
const PERSONAL_RAW = `raw/${PERSONAL_ID}/msg-3.eml`;

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM attachment"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox_member"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
  await Promise.all(
    [EXPIRED_RAW, EXPIRED_ATT, FRESH_RAW, PERSONAL_RAW].map((key) => e.BLOBS.delete(key)),
  );
}

async function seed(now: Date): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com", kind: "primary" });
  await db.insert(mailbox).values([
    {
      id: EXPIRED_ID,
      domainId: DOMAIN_ID,
      localPart: "expired",
      type: "temp",
      ownerUserId: OWNER_ID,
      expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
    },
    {
      id: FRESH_ID,
      domainId: DOMAIN_ID,
      localPart: "fresh",
      type: "temp",
      ownerUserId: OWNER_ID,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
    {
      id: PERSONAL_ID,
      domainId: DOMAIN_ID,
      localPart: "me",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
  ]);

  await db.insert(thread).values([
    { id: "thread-expired", mailboxId: EXPIRED_ID },
    { id: "thread-fresh", mailboxId: FRESH_ID },
    { id: "thread-personal", mailboxId: PERSONAL_ID },
  ]);

  await db.insert(message).values([
    {
      id: "msg-1",
      mailboxId: EXPIRED_ID,
      threadId: "thread-expired",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: EXPIRED_RAW,
    },
    {
      id: "msg-2",
      mailboxId: FRESH_ID,
      threadId: "thread-fresh",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: FRESH_RAW,
    },
    {
      id: "msg-3",
      mailboxId: PERSONAL_ID,
      threadId: "thread-personal",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: PERSONAL_RAW,
    },
  ]);

  await db.insert(attachment).values({
    id: "att-1",
    messageId: "msg-1",
    filename: "file.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    r2Key: EXPIRED_ATT,
  });

  await e.BLOBS.put(EXPIRED_RAW, "raw-expired");
  await e.BLOBS.put(EXPIRED_ATT, "hello");
  await e.BLOBS.put(FRESH_RAW, "raw-fresh");
  await e.BLOBS.put(PERSONAL_RAW, "raw-personal");
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let acc = "";
  while (!acc.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    const timed = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
    const result = await Promise.race([reader.read(), timed]);
    if (result === null) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    if (result.done) throw new Error(`stream ended before ${needle}; got: ${acc}`);
    acc += decoder.decode(result.value, { stream: true });
  }
  return acc;
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
});

describe("runCron — temp mailbox GC", () => {
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  afterEach(async () => {
    const toClose = readers.splice(0, readers.length);
    await Promise.all(toClose.map((r) => r.cancel().catch(() => undefined)));
  });

  it("deletes expired temp mailboxes, their R2 blobs, and broadcasts mailbox_expired", async () => {
    const now = new Date();
    await seed(now);

    const stub = e.USER_HUB.get(e.USER_HUB.idFromName(OWNER_ID));
    const res = await stub.fetch("https://hub/subscribe");
    if (!res.body) throw new Error("subscribe returned no body");
    const reader = res.body.getReader();
    readers.push(reader);

    await runCron(e, now);

    const remaining = await db.query.mailbox.findMany();
    const remainingIds = new Set(remaining.map((m) => m.id));
    expect(remainingIds.has(EXPIRED_ID)).toBe(false);
    expect(remainingIds.has(FRESH_ID)).toBe(true);
    expect(remainingIds.has(PERSONAL_ID)).toBe(true);

    expect(await db.query.message.findFirst({ where: eq(message.id, "msg-1") })).toBeUndefined();
    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-expired") }),
    ).toBeUndefined();
    expect(
      await db.query.attachment.findFirst({ where: eq(attachment.id, "att-1") }),
    ).toBeUndefined();

    expect(await e.BLOBS.head(EXPIRED_RAW)).toBeNull();
    expect(await e.BLOBS.head(EXPIRED_ATT)).toBeNull();
    expect(await e.BLOBS.head(FRESH_RAW)).not.toBeNull();
    expect(await e.BLOBS.head(PERSONAL_RAW)).not.toBeNull();

    const received = await readUntil(reader, "event: mailbox_expired");
    expect(received).toContain(`"mailboxId":"${EXPIRED_ID}"`);
  });

  it("is a no-op when no temp mailboxes are expired", async () => {
    const now = new Date();
    await seed(now);

    await db
      .update(mailbox)
      .set({ expiresAt: new Date(now.getTime() + 60 * 60 * 1000) })
      .where(eq(mailbox.id, EXPIRED_ID));

    await runCron(e, now);

    const remaining = await db.query.mailbox.findMany();
    expect(remaining).toHaveLength(3);
    expect(await e.BLOBS.head(EXPIRED_RAW)).not.toBeNull();
    expect(await e.BLOBS.head(EXPIRED_ATT)).not.toBeNull();
  });

  it("leaves non-temp mailboxes with a past expiresAt alone", async () => {
    const now = new Date();
    await seed(now);

    await db
      .update(mailbox)
      .set({ expiresAt: new Date(now.getTime() - 60 * 60 * 1000) })
      .where(eq(mailbox.id, PERSONAL_ID));

    await runCron(e, now);

    const personal = await db.query.mailbox.findFirst({ where: eq(mailbox.id, PERSONAL_ID) });
    expect(personal).toBeDefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).not.toBeNull();
  });
});

describe("runCron — trash retention purge", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("purges threads trashed past the retention window, with their blobs", async () => {
    const now = new Date();
    await seed(now);

    // thread-personal trashed 31 days ago → purged.
    await db
      .update(thread)
      .set({ trashed: true, trashedAt: new Date(now.getTime() - 31 * DAY) })
      .where(eq(thread.id, "thread-personal"));
    // thread-fresh trashed 5 days ago → kept.
    await db
      .update(thread)
      .set({ trashed: true, trashedAt: new Date(now.getTime() - 5 * DAY) })
      .where(eq(thread.id, "thread-fresh"));

    await runCron(e, now);

    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-personal") }),
    ).toBeUndefined();
    expect(await db.query.message.findFirst({ where: eq(message.id, "msg-3") })).toBeUndefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).toBeNull();

    expect(await db.query.thread.findFirst({ where: eq(thread.id, "thread-fresh") })).toBeDefined();
    expect(await e.BLOBS.head(FRESH_RAW)).not.toBeNull();
  });

  it("leaves trashed threads with a null trashedAt alone", async () => {
    const now = new Date();
    await seed(now);

    await db
      .update(thread)
      .set({ trashed: true, trashedAt: null })
      .where(eq(thread.id, "thread-personal"));

    await runCron(e, now);

    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-personal") }),
    ).toBeDefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).not.toBeNull();
  });
});
