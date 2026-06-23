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
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
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
  // Seed an existing thread with a stored ancestor message. `from` becomes a
  // known participant so a reply from that address corroborates the join.
  async function seedThread(opts: {
    from: string;
    lastMsgAt?: Date;
    parentId?: string;
  }): Promise<string> {
    const threadId = crypto.randomUUID();
    await db.insert(thread).values({
      id: threadId,
      mailboxId: MAILBOX_ID,
      subjectNorm: "hello",
      lastMsgAt: opts.lastMsgAt ?? new Date(),
      msgCount: 1,
      participants: [{ address: opts.from }],
    });
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId,
      direction: "in",
      messageIdHdr: opts.parentId ?? "<parent@example.com>",
      fromAddr: opts.from,
      subject: "Hello",
    });
    return threadId;
  }

  it("reuses an existing thread when a known participant replies to a stored ancestor", async () => {
    const threadId = await seedThread({ from: "x@example.com" });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });

    expect(resolved.threadId).toBe(threadId);
    expect(resolved.joinedByHeader).toBe(true);
  });

  it("does not splice into a thread when the sender is not a participant", async () => {
    // Attacker learns a Message-ID and forges In-Reply-To to graft in.
    const threadId = await seedThread({ from: "victim@example.com" });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "attacker@evil.test" }],
      fromAddr: "attacker@evil.test",
    });

    expect(resolved.threadId).not.toBe(threadId);
    expect(resolved.joinedByHeader).toBe(false);
  });

  it("does not splice into a stale thread even for a known participant", async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365); // ~1 year
    const threadId = await seedThread({ from: "x@example.com", lastMsgAt: old });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });

    expect(resolved.threadId).not.toBe(threadId);
  });

  it("concurrent resolves with the same parent collapse to one thread", async () => {
    const input = {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<orphan@example.com>",
      references: ["<orphan@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    };

    const [a, b, c] = await Promise.all([
      resolveThreadId(db, input),
      resolveThreadId(db, input),
      resolveThreadId(db, input),
    ]);

    expect(a.threadId).toBe(b.threadId);
    expect(b.threadId).toBe(c.threadId);

    const rows = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.threadId);
  });

  it("different mailboxes with the same parent get different thread ids", async () => {
    const base = {
      subject: "Re: Hello",
      inReplyTo: "<orphan@example.com>",
      references: ["<orphan@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    };

    const a = await resolveThreadId(db, { ...base, mailboxId: MAILBOX_ID });
    const b = await resolveThreadId(db, { ...base, mailboxId: OTHER_MAILBOX_ID });

    expect(a.threadId).not.toBe(b.threadId);
  });

  it("creates a new thread when no headers and no recent subject match", async () => {
    const a = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Hello",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    const b = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Other",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    expect(a.threadId).not.toBe(b.threadId);
  });

  it("falls back to the subject window when no headers are present", async () => {
    const a = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Hello",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    // Store a message so the thread keeps its lastMsgAt fresh.
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId: a.threadId,
      direction: "in",
      fromAddr: "x@example.com",
      subject: "Hello",
    });
    const b = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    expect(b.threadId).toBe(a.threadId);
  });
});
