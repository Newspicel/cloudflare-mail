import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import {
  domain,
  folder,
  label,
  mailbox,
  message,
  messageLabel,
  rule,
  type RuleAction,
  type RuleCondition,
  thread,
  threadFolder,
  user,
} from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
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
const LABEL_ID = "label-1";
const FOLDER_ID = "folder-1";
const SENDER = "stranger@elsewhere.com";

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM thread_folder"),
    e.DB.prepare("DELETE FROM message_label"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM rule"),
    e.DB.prepare("DELETE FROM label"),
    e.DB.prepare("DELETE FROM folder"),
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
    // Isolate rule behaviour from the spam filter.
    spamFilter: "off",
  });
  await db.insert(label).values({ id: LABEL_ID, mailboxId: MAILBOX_ID, name: "Newsletters" });
  await db.insert(folder).values({ id: FOLDER_ID, userId: OWNER_ID, name: "Archive" });
}

async function addRule(opts: {
  name: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  conditionMode?: "all" | "any";
  priority?: number;
}): Promise<void> {
  await db.insert(rule).values({
    id: `rule-${opts.name}`,
    mailboxId: MAILBOX_ID,
    createdBy: OWNER_ID,
    name: opts.name,
    conditions: opts.conditions,
    conditionMode: opts.conditionMode ?? "all",
    actions: opts.actions,
    priority: opts.priority ?? 0,
  });
}

interface StubMessage extends ForwardableEmailMessage {
  rejected?: string;
}

function stubInbound(opts: { from: string; to: string; raw?: string }): StubMessage {
  const raw =
    opts.raw ??
    [`From: Stranger <${opts.from}>`, `To: Me <${opts.to}>`, `Subject: Hello`, ``, `body`, ``].join(
      "\r\n",
    );
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

async function onlyMessage() {
  const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("handleInbound — rules engine", () => {
  it("applies a label when a from-condition matches", async () => {
    await addRule({
      name: "label-news",
      conditions: [{ field: "from", op: "contains", value: "stranger@" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links.map((l) => l.labelId)).toEqual([LABEL_ID]);
  });

  it("files the thread into the creator's folder on moveFolder", async () => {
    await addRule({
      name: "file-archive",
      conditions: [{ field: "subject", op: "contains", value: "hello" }],
      actions: [{ type: "moveFolder", folderId: FOLDER_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const filed = await db.query.threadFolder.findMany({
      where: eq(threadFolder.threadId, row.threadId),
    });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.userId).toBe(OWNER_ID);
    expect(filed[0]!.folderId).toBe(FOLDER_ID);
  });

  it("marks the message read and keeps the thread unread count at zero", async () => {
    await addRule({
      name: "auto-read",
      conditions: [{ field: "from", op: "endsWith", value: "@elsewhere.com" }],
      actions: [{ type: "markRead" }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    expect(row.flags & Flag.SEEN).toBe(Flag.SEEN);
    const th = (await db.query.thread.findMany({ where: eq(thread.id, row.threadId) }))[0]!;
    expect(th.unreadCount).toBe(0);
  });

  it("files to spam on markSpam even for an authenticated new thread", async () => {
    await addRule({
      name: "spam-it",
      conditions: [{ field: "subject", op: "equals", value: "hello" }],
      actions: [{ type: "markSpam" }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const th = (await db.query.thread.findMany({ where: eq(thread.id, row.threadId) }))[0]!;
    expect(th.spam).toBe(true);
  });

  it("hard-blocks (SMTP reject) and stores nothing", async () => {
    await addRule({
      name: "block",
      conditions: [{ field: "from", op: "contains", value: "stranger" }],
      actions: [{ type: "hardBlock" }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Address not found");

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(0);
  });

  it("does not act when conditions don't match", async () => {
    await addRule({
      name: "no-match",
      conditions: [{ field: "from", op: "contains", value: "nope@nowhere" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links).toHaveLength(0);
  });

  it("requires all conditions in 'all' mode", async () => {
    await addRule({
      name: "all-mode",
      conditionMode: "all",
      conditions: [
        { field: "from", op: "contains", value: "stranger" },
        { field: "subject", op: "contains", value: "invoice" },
      ],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS }); // subject "Hello", no "invoice"
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links).toHaveLength(0);
  });

  it("stops at a stopProcessing rule before lower-priority rules run", async () => {
    await addRule({
      name: "first-stop",
      priority: 0,
      conditions: [{ field: "from", op: "contains", value: "stranger" }],
      actions: [{ type: "markRead" }, { type: "stopProcessing" }],
    });
    await addRule({
      name: "second-label",
      priority: 1,
      conditions: [{ field: "from", op: "contains", value: "stranger" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    expect(row.flags & Flag.SEEN).toBe(Flag.SEEN);
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links).toHaveLength(0);
  });
});
