import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import {
  attachment,
  domain,
  mailbox,
  mailboxMember,
  message,
  thread,
  user,
} from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    e.DB.prepare("DELETE FROM attachment"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox_member"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
}

async function seed(): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
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

describe("handleInbound — plus/sub-addressing", () => {
  it("routes hi+tag@ to the hi@ mailbox and stores the full envelope recipient", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "me+newsletter@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredTo).toBe("me+newsletter@example.com");
  });

  it("matches the base local part case-insensitively", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "ME+Tag@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
  });

  it("rejects when the base local part has no mailbox", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "nobody+tag@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Address not found");
  });
});

describe("handleInbound — full pipeline", () => {
  const MEMBER_ID = "user-member";
  const SENDER_ADDR = "sender@elsewhere.com";
  const SENDER_FORMATTED = `Sender <${SENDER_ADDR}>`;
  const MSG_ID_HDR = "<integ-1@elsewhere.com>";
  const ATT_BYTES = "hello attachment";
  const ATT_B64 = "aGVsbG8gYXR0YWNobWVudA==";
  const RAW_EML = [
    `From: ${SENDER_FORMATTED}`,
    `To: Me <${ADDRESS}>`,
    `Subject: Integration Test`,
    `Message-ID: ${MSG_ID_HDR}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="BOUND"`,
    ``,
    `--BOUND`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Hello from integration test.`,
    ``,
    `--BOUND`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Disposition: attachment; filename="notes.txt"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    ATT_B64,
    ``,
    `--BOUND--`,
    ``,
  ].join("\r\n");

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  async function subscribe(userId: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const stub = e.USER_HUB.get(e.USER_HUB.idFromName(userId));
    const res = await stub.fetch("https://hub/subscribe");
    if (!res.body) throw new Error("subscribe returned no body");
    const reader = res.body.getReader();
    readers.push(reader);
    return reader;
  }

  beforeEach(async () => {
    await db.insert(user).values({ id: MEMBER_ID, name: "Member", email: "member@example.com" });
    await db.insert(mailboxMember).values({
      mailboxId: MAILBOX_ID,
      userId: MEMBER_ID,
      perms: Perm.READ,
    });
  });

  afterEach(async () => {
    const toClose = readers.splice(0, readers.length);
    await Promise.all(toClose.map((r) => r.cancel().catch(() => undefined)));
  });

  it("persists message + thread + attachment + raw blob and broadcasts to owner and members", async () => {
    const ownerReader = await subscribe(OWNER_ID);
    const memberReader = await subscribe(MEMBER_ID);

    const msg = stubInbound({ from: SENDER_ADDR, to: ADDRESS, raw: RAW_EML });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const msgs = await db.query.message.findMany({
      where: eq(message.mailboxId, MAILBOX_ID),
    });
    expect(msgs).toHaveLength(1);
    const row = msgs[0]!;
    expect(row.direction).toBe("in");
    expect(row.subject).toBe("Integration Test");
    expect(row.fromAddr).toBe(SENDER_ADDR);
    expect(row.fromName).toBe("Sender");
    expect(row.messageIdHdr).toBe(MSG_ID_HDR);
    expect(row.toAddrs).toEqual([{ name: "Me", address: ADDRESS }]);
    expect(row.snippet).toBe("Hello from integration test.");
    expect(row.sizeBytes).toBe(new TextEncoder().encode(RAW_EML).byteLength);
    expect(row.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/[0-9a-f-]+\\.eml$`));
    expect(row.receivedAt).toBeInstanceOf(Date);
    expect(row.sentAt).toBeNull();

    const threads = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(row.threadId);
    expect(threads[0]!.subjectNorm).toBe("integration test");
    expect(threads[0]!.msgCount).toBe(1);
    expect(threads[0]!.unreadCount).toBe(1);

    const atts = await db.query.attachment.findMany({ where: eq(attachment.messageId, row.id) });
    expect(atts).toHaveLength(1);
    const att = atts[0]!;
    expect(att.filename).toBe("notes.txt");
    expect(att.contentType).toBe("text/plain");
    expect(att.sizeBytes).toBe(ATT_BYTES.length);
    expect(att.r2Key).toBe(`att/${row.id}/0-notes.txt`);
    expect(att.inline).toBe(false);

    const rawBlob = await e.BLOBS.get(row.rawR2Key!);
    expect(rawBlob).not.toBeNull();
    expect(rawBlob!.httpMetadata?.contentType).toBe("message/rfc822");
    expect(await rawBlob!.text()).toBe(RAW_EML);

    const attBlob = await e.BLOBS.get(att.r2Key);
    expect(attBlob).not.toBeNull();
    expect(await attBlob!.text()).toBe(ATT_BYTES);

    await Promise.all([
      readUntil(ownerReader, "event: new_message"),
      readUntil(memberReader, "event: new_message"),
    ]);
  });
});

describe("handleInbound — service mailboxes", () => {
  async function seedService(mode: "duplex" | "send"): Promise<void> {
    await db.insert(mailbox).values({
      id: "mailbox-svc",
      domainId: DOMAIN_ID,
      localPart: "svc",
      type: "service",
      ownerUserId: OWNER_ID,
      serviceMode: mode,
      spamFilter: "off",
    });
  }

  it("hard-bounces inbound to a send-only service mailbox", async () => {
    await seedService("send");
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "svc@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Send-only address");

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, "mailbox-svc") });
    expect(rows).toHaveLength(0);
  });

  it("stores inbound to a duplex service mailbox for polling", async () => {
    await seedService("duplex");
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "svc@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, "mailbox-svc") });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe("in");
  });
});

describe("handleInbound — spam filtering (default standard level)", () => {
  const SENDER = "stranger@elsewhere.com";

  function eml(
    authResults: string | null,
    extra: { subject?: string; body?: string } = {},
  ): string {
    const lines = [`From: Stranger <${SENDER}>`, `To: Me <${ADDRESS}>`];
    if (authResults) lines.push(`Authentication-Results: ${authResults}`);
    lines.push(
      `Subject: ${extra.subject ?? "Hi there"}`,
      ``,
      extra.body ?? "A normal message body.",
      ``,
    );
    return lines.join("\r\n");
  }

  it("files DMARC-failing mail into Spam with a verdict and reasons", async () => {
    const msg = stubInbound({
      from: SENDER,
      to: ADDRESS,
      raw: eml("mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"),
    });
    await handleInbound(msg, e);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("spam");
    expect(row.spamReasons?.length).toBeGreaterThan(0);

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(true);
  });

  it("leaves fully authenticated mail clean in the inbox", async () => {
    const msg = stubInbound({
      from: SENDER,
      to: ADDRESS,
      raw: eml("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
    });
    await handleInbound(msg, e);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("clean");

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(false);
  });

  it("marks partially authenticated mail (no DMARC) suspicious but keeps it in the inbox", async () => {
    const msg = stubInbound({
      from: SENDER,
      to: ADDRESS,
      raw: eml("mx.cloudflare.net; spf=pass; dkim=none; dmarc=none"),
    });
    await handleInbound(msg, e);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("suspicious");

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(false);
  });
});
