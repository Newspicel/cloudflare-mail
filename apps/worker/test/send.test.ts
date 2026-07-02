import { draft, message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import type { SendMessageInput } from "@cfmail/shared/schemas";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../src/cron.ts";
import type { Env } from "../src/env.ts";
import { sendFromMailbox } from "../src/mail/send.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { MAILBOX_ID, OWNER_ID, seedBase, seedThread } from "./support/seed.ts";

// The EMAIL binding has no local simulation, so tests swap in a fake. The
// success shape mirrors the platform's structured send (`{ messageId }`).
function emailOk(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => ({ messageId: "platform-mid" })) };
}
function emailFail(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => Promise.reject(new Error("delivery exploded"))) };
}
function envWith(email: { send: unknown }): Env {
  return { ...e, EMAIL: email as unknown as Env["EMAIL"] } as Env;
}

const SENT_PREFIX = `raw/${MAILBOX_ID}/sent/`;

async function sentBlobKeys(): Promise<string[]> {
  const listed = await e.BLOBS.list({ prefix: SENT_PREFIX });
  return listed.objects.map((o) => o.key);
}

function input(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    mailboxId: MAILBOX_ID,
    to: [{ address: "recipient@elsewhere.test" }],
    subject: "Greetings",
    text: "hello there",
    ...overrides,
  } as SendMessageInput;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  const stale = await sentBlobKeys();
  await Promise.all(stale.map((key) => e.BLOBS.delete(key)));
});

describe("sendFromMailbox — success", () => {
  it("persists the raw blob and message row, and creates the thread", async () => {
    const email = emailOk();
    const res = await sendFromMailbox(envWith(email), db(), OWNER_ID, input());

    expect(email.send).toHaveBeenCalledTimes(1);
    const row = await db().query.message.findFirst({ where: eq(message.id, res.messageId) });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      mailboxId: MAILBOX_ID,
      threadId: res.threadId,
      direction: "out",
      fromAddr: "team@example.com",
      subject: "Greetings",
    });
    expect(row!.flags & Flag.SENT).toBe(Flag.SENT);
    expect(row!.flags & Flag.SEEN).toBe(Flag.SEEN);
    expect(row!.rawR2Key).toBe(`${SENT_PREFIX}${res.messageId}.eml`);
    expect(await e.BLOBS.head(row!.rawR2Key!)).not.toBeNull();

    const t = await db().query.thread.findFirst({ where: eq(thread.id, res.threadId) });
    expect(t).toBeDefined();
  });

  it("adopts the platform-assigned Message-ID for threading", async () => {
    const res = await sendFromMailbox(envWith(emailOk()), db(), OWNER_ID, input());
    const row = await db().query.message.findFirst({ where: eq(message.id, res.messageId) });
    expect(row?.messageIdHdr).toBe("<platform-mid>");
  });
});

describe("sendFromMailbox — delivery failure cleanup", () => {
  it("throws 502 and leaves no orphan row, blob, or empty thread", async () => {
    const err = await sendFromMailbox(envWith(emailFail()), db(), OWNER_ID, input()).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(502);

    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await db().query.thread.findMany()).toHaveLength(0);
    expect(await sentBlobKeys()).toHaveLength(0);
  });

  it("keeps a pre-existing thread (and its messages) when a reply's delivery fails", async () => {
    const { threadId, messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({ messageIdHdr: "<orig@example.com>" })
      .where(eq(message.id, messageId));

    await expect(
      sendFromMailbox(
        envWith(emailFail()),
        db(),
        OWNER_ID,
        input({ subject: "Re: hello", inReplyTo: "<orig@example.com>" }),
      ),
    ).rejects.toMatchObject({ status: 502 });

    // The failed reply is rolled back, but the original thread + message stay.
    expect(await db().query.thread.findFirst({ where: eq(thread.id, threadId) })).toBeDefined();
    const rows = await db().query.message.findMany({ where: eq(message.threadId, threadId) });
    expect(rows.map((r) => r.id)).toEqual([messageId]);
  });

  it("a retry after a failed send does not duplicate Sent entries", async () => {
    await expect(sendFromMailbox(envWith(emailFail()), db(), OWNER_ID, input())).rejects.toThrow();
    const res = await sendFromMailbox(envWith(emailOk()), db(), OWNER_ID, input());
    const rows = await db().query.message.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(res.messageId);
    expect(await sentBlobKeys()).toEqual([`${SENT_PREFIX}${res.messageId}.eml`]);
  });
});

describe("scheduled-send dispatch (cron)", () => {
  const payload = {
    mailboxId: MAILBOX_ID,
    to: [{ address: "recipient@elsewhere.test" }],
    subject: "Later",
    text: "deferred hello",
  };

  async function seedScheduledDraft(attempts = 0): Promise<string> {
    const id = `draft-${crypto.randomUUID()}`;
    await db()
      .insert(draft)
      .values({
        id,
        mailboxId: MAILBOX_ID,
        userId: OWNER_ID,
        scheduledFor: new Date(Date.now() - 60_000),
        scheduledPayload: payload,
        scheduledAttempts: attempts,
      });
    return id;
  }

  it("dispatches a due draft: message persisted, draft deleted", async () => {
    const id = await seedScheduledDraft();
    await runCron(envWith(emailOk()), new Date());

    expect(await db().query.draft.findFirst({ where: eq(draft.id, id) })).toBeUndefined();
    const rows = await db().query.message.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "out", subject: "Later" });
  });

  it("a failing dispatch keeps the draft scheduled for retry and rolls back the send", async () => {
    const id = await seedScheduledDraft();
    await runCron(envWith(emailFail()), new Date());

    const row = await db().query.draft.findFirst({ where: eq(draft.id, id) });
    expect(row).toBeDefined();
    expect(row?.scheduledAttempts).toBe(1);
    // Still in the past → next tick retries it.
    expect(row?.scheduledFor).not.toBeNull();
    expect(row?.scheduledPayload).not.toBeNull();
    // The failed attempt left no partial send behind (retry safety).
    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await sentBlobKeys()).toHaveLength(0);
  });

  it("a retry after a failed tick sends exactly once", async () => {
    const id = await seedScheduledDraft();
    await runCron(envWith(emailFail()), new Date());
    await runCron(envWith(emailOk()), new Date());

    expect(await db().query.draft.findFirst({ where: eq(draft.id, id) })).toBeUndefined();
    expect(await db().query.message.findMany()).toHaveLength(1);
  });

  it("exhausted retries revert the row to an editable draft with the error flagged", async () => {
    const id = await seedScheduledDraft(2); // one failure away from the cap of 3
    await runCron(envWith(emailFail()), new Date());

    const row = await db().query.draft.findFirst({ where: eq(draft.id, id) });
    expect(row).toBeDefined();
    expect(row?.scheduledFor).toBeNull();
    expect(row?.scheduledPayload).toBeNull();
    expect(row?.scheduledAttempts).toBe(3);
    expect(row?.scheduledError).toContain("delivery exploded");
    expect(await db().query.message.findMany()).toHaveLength(0);
  });
});
