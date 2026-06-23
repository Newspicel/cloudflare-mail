import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { attachment, domain, mailbox, message, thread, user } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { ingestRaw, isAuthenticated } from "../src/mail/ingest.ts";
import type { SpamEvaluation } from "../src/mail/spam.ts";

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

function eml(opts: { from?: string; to?: string; subject?: string; messageId?: string; body?: string } = {}): ArrayBuffer {
  const lines = [
    `From: ${opts.from ?? `Sender <sender@elsewhere.com>`}`,
    `To: ${opts.to ?? `Me <${ADDRESS}>`}`,
    `Subject: ${opts.subject ?? "Imported"}`,
  ];
  if (opts.messageId) lines.push(`Message-ID: ${opts.messageId}`);
  lines.push("", opts.body ?? "Hello from an import.", "");
  return new TextEncoder().encode(lines.join("\r\n")).buffer as ArrayBuffer;
}

// Defaults matching the import endpoint: no spam evaluation, explicit direction.
function importOpts(over: Partial<Parameters<typeof ingestRaw>[2]> = {}) {
  return {
    mailboxId: MAILBOX_ID,
    raw: eml(),
    direction: "in" as const,
    deliveredTo: null,
    flags: 0,
    receivedAt: new Date("2024-01-02T03:04:05Z"),
    sentAt: null,
    spam: null as SpamEvaluation | null,
    ...over,
  };
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ingestRaw — inbound import", () => {
  it("stores an inbound message, archives the raw blob, and bumps the thread", async () => {
    const res = await ingestRaw(e, db, importOpts());
    expect(res.isNewThread).toBe(true);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.direction).toBe("in");
    expect(row.subject).toBe("Imported");
    expect(row.fromAddr).toBe("sender@elsewhere.com");
    expect(row.receivedAt).toEqual(new Date("2024-01-02T03:04:05Z"));
    expect(row.sentAt).toBeNull();
    expect(row.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/[0-9a-f-]+\\.eml$`));

    const blob = await e.BLOBS.get(row.rawR2Key!);
    expect(blob).not.toBeNull();
    expect(blob!.httpMetadata?.contentType).toBe("message/rfc822");

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.msgCount).toBe(1);
    expect(th.lastMsgAt).toEqual(new Date("2024-01-02T03:04:05Z"));
  });

  it("counts an unseen inbound message as unread", async () => {
    await ingestRaw(e, db, importOpts({ flags: 0 }));
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.unreadCount).toBe(1);
  });

  it("does not count a SEEN inbound message as unread", async () => {
    await ingestRaw(e, db, importOpts({ flags: Flag.SEEN }));
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.unreadCount).toBe(0);
  });
});

describe("ingestRaw — outbound import", () => {
  it("stores an outbound message with sentAt and never bumps unread", async () => {
    await ingestRaw(
      e,
      db,
      importOpts({
        raw: eml({ from: `Me <${ADDRESS}>`, to: "Friend <friend@elsewhere.com>" }),
        direction: "out",
        receivedAt: null,
        sentAt: new Date("2024-05-06T07:08:09Z"),
      }),
    );

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.direction).toBe("out");
    expect(row.sentAt).toEqual(new Date("2024-05-06T07:08:09Z"));
    expect(row.receivedAt).toBeNull();

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.unreadCount).toBe(0);
    expect(th.lastMsgAt).toEqual(new Date("2024-05-06T07:08:09Z"));
  });
});

describe("ingestRaw — spam=null (import never files or scores)", () => {
  it("leaves all spam fields null and never auto-files to Spam", async () => {
    await ingestRaw(e, db, importOpts({ spam: null }));
    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBeNull();
    expect(row.spamScore).toBeNull();
    expect(row.spamReasons).toBeNull();
    expect(row.spamAuth).toBeNull();

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(false);
  });

  it("auto-files a brand-new thread when spam.folderSpam is set", async () => {
    const spam: SpamEvaluation = {
      verdict: "spam",
      score: 9,
      reasons: ["dmarc=fail"],
      auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
      folderSpam: true,
    };
    await ingestRaw(e, db, importOpts({ spam }));
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(true);
    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("spam");
  });
});

describe("ingestRaw — attachments", () => {
  const RAW = [
    `From: Sender <sender@elsewhere.com>`,
    `To: Me <${ADDRESS}>`,
    `Subject: With attachment`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="B"`,
    ``,
    `--B`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `body`,
    `--B`,
    `Content-Type: application/pdf; name="weird name!.pdf"`,
    `Content-Disposition: attachment; filename="weird name!.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    `aGVsbG8=`,
    `--B--`,
    ``,
  ].join("\r\n");

  it("stores attachments to R2 with a sanitized filename in the key", async () => {
    await ingestRaw(e, db, importOpts({ raw: new TextEncoder().encode(RAW).buffer as ArrayBuffer }));
    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    const atts = await db.query.attachment.findMany({ where: eq(attachment.messageId, row.id) });
    expect(atts).toHaveLength(1);
    const att = atts[0]!;
    expect(att.filename).toBe("weird name!.pdf"); // original kept on the row
    expect(att.r2Key).toBe(`att/${row.id}/0-weird_name_.pdf`); // sanitized in the key
    expect(await (await e.BLOBS.get(att.r2Key))!.text()).toBe("hello");
  });
});

describe("isAuthenticated", () => {
  it("trusts DMARC pass alone", () => {
    expect(isAuthenticated({ spf: "fail", dkim: "fail", dmarc: "pass" })).toBe(true);
  });

  it("trusts SPF+DKIM pass without DMARC", () => {
    expect(isAuthenticated({ spf: "pass", dkim: "pass", dmarc: "none" })).toBe(true);
  });

  it("does not trust SPF-only or DKIM-only", () => {
    expect(isAuthenticated({ spf: "pass", dkim: "fail", dmarc: "none" })).toBe(false);
    expect(isAuthenticated({ spf: "fail", dkim: "pass", dmarc: "none" })).toBe(false);
  });
});
