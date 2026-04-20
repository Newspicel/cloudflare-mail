import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { domain, mailbox, message, user } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { handleInbound } from "../src/mail/receive.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const MAILBOX_ID = "mailbox-1";
const ADDRESS = "me@example.com";

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
}

async function seed(): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com", kind: "primary" });
  await db.insert(mailbox).values({
    id: MAILBOX_ID,
    domainId: DOMAIN_ID,
    localPart: "me",
    type: "personal",
    ownerUserId: OWNER_ID,
  });
}

interface StubMessage extends ForwardableEmailMessage {
  rejected?: string;
}

function stubInbound(opts: { from: string; to: string; raw?: string }): StubMessage {
  const raw = opts.raw ?? "From: x\r\nTo: y\r\nSubject: t\r\n\r\nbody\r\n";
  const stream = new Response(raw).body;
  if (!stream) throw new Error("no stream");
  const stub = {
    from: opts.from,
    to: opts.to,
    headers: new Headers(),
    raw: stream,
    rawSize: raw.length,
    rejected: undefined as string | undefined,
    setReject(reason: string) {
      this.rejected = reason;
    },
    async forward() {},
    async reply() {},
  };
  return stub as unknown as StubMessage;
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("handleInbound — bounce-loop protection", () => {
  it("rejects when envelope sender equals envelope recipient", async () => {
    const msg = stubInbound({ from: ADDRESS, to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Sender equals recipient");

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(0);
  });

  it("rejects when sender and recipient differ only in case/whitespace", async () => {
    const msg = stubInbound({ from: " ME@Example.com ", to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Sender equals recipient");
  });

  it("does not reject a normal inbound from a different sender", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();
  });
});
