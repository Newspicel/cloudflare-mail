import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { attachment, domain, mailbox, message, thread, user } from "@cfmail/db/schema";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "../src/mail/blobs.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const USER_ID = "user-1";
const DOMAIN_ID = "domain-1";
const MAILBOX_A = "mailbox-a";
const MAILBOX_B = "mailbox-b";

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM attachment"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
}

async function seed(): Promise<{ rawKey: string; attKey: string; otherRawKey: string }> {
  await db.insert(user).values({ id: USER_ID, name: "U", email: "u@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
  await db.insert(mailbox).values([
    { id: MAILBOX_A, domainId: DOMAIN_ID, localPart: "a", type: "personal", ownerUserId: USER_ID },
    { id: MAILBOX_B, domainId: DOMAIN_ID, localPart: "b", type: "personal", ownerUserId: USER_ID },
  ]);

  await db.insert(thread).values([
    { id: "thread-a", mailboxId: MAILBOX_A },
    { id: "thread-b", mailboxId: MAILBOX_B },
  ]);

  const rawKey = `raw/${MAILBOX_A}/msg-1.eml`;
  const attKey = `att/msg-1/0-file.txt`;
  const otherRawKey = `raw/${MAILBOX_B}/msg-2.eml`;

  await db.insert(message).values([
    {
      id: "msg-1",
      mailboxId: MAILBOX_A,
      threadId: "thread-a",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: rawKey,
    },
    {
      id: "msg-2",
      mailboxId: MAILBOX_B,
      threadId: "thread-b",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: otherRawKey,
    },
  ]);
  await db.insert(attachment).values({
    id: "att-1",
    messageId: "msg-1",
    filename: "file.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    r2Key: attKey,
  });

  await e.BLOBS.put(rawKey, "raw-a");
  await e.BLOBS.put(attKey, "hello");
  await e.BLOBS.put(otherRawKey, "raw-b");

  return { rawKey, attKey, otherRawKey };
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
});

describe("collectMailboxBlobKeys", () => {
  it("returns raw + attachment keys scoped to the given mailbox", async () => {
    const { rawKey, attKey, otherRawKey } = await seed();

    const keys = await collectMailboxBlobKeys(db, MAILBOX_A);
    expect(new Set(keys)).toEqual(new Set([rawKey, attKey]));
    expect(keys).not.toContain(otherRawKey);
  });

  it("returns [] for a mailbox with no messages", async () => {
    await seed();
    await e.DB.prepare("DELETE FROM message WHERE mailbox_id = ?").bind(MAILBOX_A).run();
    const keys = await collectMailboxBlobKeys(db, MAILBOX_A);
    expect(keys).toEqual([]);
  });
});

describe("deleteBlobs", () => {
  it("removes the given keys from R2 and leaves unrelated keys intact", async () => {
    const { rawKey, attKey, otherRawKey } = await seed();

    const keys = await collectMailboxBlobKeys(db, MAILBOX_A);
    await deleteBlobs(e, keys);

    expect(await e.BLOBS.head(rawKey)).toBeNull();
    expect(await e.BLOBS.head(attKey)).toBeNull();
    expect(await e.BLOBS.head(otherRawKey)).not.toBeNull();
  });

  it("is a no-op for an empty list", async () => {
    await expect(deleteBlobs(e, [])).resolves.toBeUndefined();
  });
});
