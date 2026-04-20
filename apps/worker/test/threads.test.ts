import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { domain, mailbox, message, thread, user } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { resolveThreadId } from "../src/mail/threads.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const MAILBOX_ID = "mailbox-1";
const OTHER_MAILBOX_ID = "mailbox-2";

async function seed(): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com", kind: "primary" });
  await db.insert(mailbox).values([
    {
      id: MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "a",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
    {
      id: OTHER_MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "b",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
  ]);
}

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("resolveThreadId", () => {
  it("reuses an existing thread when an ancestor message is stored", async () => {
    const threadId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    await db.insert(thread).values({
      id: threadId,
      mailboxId: MAILBOX_ID,
      subjectNorm: "hello",
      lastMsgAt: new Date(),
    });
    await db.insert(message).values({
      id: parentId,
      mailboxId: MAILBOX_ID,
      threadId,
      direction: "in",
      messageIdHdr: "<parent@example.com>",
      fromAddr: "x@example.com",
      subject: "Hello",
    });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "x@example.com" }],
    });

    expect(resolved).toBe(threadId);
  });

  it("concurrent resolves with the same parent collapse to one thread", async () => {
    const input = {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<orphan@example.com>",
      references: ["<orphan@example.com>"],
      participants: [{ address: "x@example.com" }],
    };

    const [a, b, c] = await Promise.all([
      resolveThreadId(db, input),
      resolveThreadId(db, input),
      resolveThreadId(db, input),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);

    const rows = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a);
  });

  it("different mailboxes with the same parent get different thread ids", async () => {
    const base = {
      subject: "Re: Hello",
      inReplyTo: "<orphan@example.com>",
      references: ["<orphan@example.com>"],
      participants: [{ address: "x@example.com" }],
    };

    const a = await resolveThreadId(db, { ...base, mailboxId: MAILBOX_ID });
    const b = await resolveThreadId(db, { ...base, mailboxId: OTHER_MAILBOX_ID });

    expect(a).not.toBe(b);
  });

  it("creates a new thread when no headers and no recent subject match", async () => {
    const a = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Hello",
      participants: [{ address: "x@example.com" }],
    });
    const b = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Other",
      participants: [{ address: "x@example.com" }],
    });
    expect(a).not.toBe(b);
  });

  it("falls back to the subject window when no headers are present", async () => {
    const a = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Hello",
      participants: [{ address: "x@example.com" }],
    });
    // Store a message so the thread keeps its lastMsgAt fresh.
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId: a,
      direction: "in",
      fromAddr: "x@example.com",
      subject: "Hello",
    });
    const b = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      participants: [{ address: "x@example.com" }],
    });
    expect(b).toBe(a);
  });
});
