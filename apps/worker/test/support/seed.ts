import {
  contactKey,
  domain,
  mailbox,
  mailboxMember,
  message,
  thread,
  user,
} from "@cfmail/db/schema";
import type { DB } from "./app.ts";

// Stable ids so tests can reference seeded rows without threading return values.
export const ADMIN_ID = "user-admin";
export const OWNER_ID = "user-owner";
export const MEMBER_ID = "user-member";
export const OUTSIDER_ID = "user-outsider";
export const DOMAIN_ID = "domain-1";
export const MAILBOX_ID = "mailbox-1";
export const OTHER_MAILBOX_ID = "mailbox-2";

export const owner = { id: OWNER_ID, email: "owner@example.com", role: "user" as const };
export const member = { id: MEMBER_ID, email: "member@example.com", role: "user" as const };
export const outsider = { id: OUTSIDER_ID, email: "outsider@example.com", role: "user" as const };
export const admin = { id: ADMIN_ID, email: "admin@example.com", role: "admin" as const };

// A baseline graph: four users, one domain, and two mailboxes owned by OWNER.
// MEMBER/OUTSIDER hold no perms until a test grants them. Routes resolve the
// owner shortcut, so OWNER can hit everything; member access is opt-in per test.
export async function seedBase(db: DB): Promise<void> {
  await db.insert(user).values([
    { id: ADMIN_ID, name: "Admin", email: admin.email, role: "admin" },
    { id: OWNER_ID, name: "Owner", email: owner.email },
    { id: MEMBER_ID, name: "Member", email: member.email },
    { id: OUTSIDER_ID, name: "Outsider", email: outsider.email },
  ]);
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
  await db.insert(mailbox).values([
    {
      id: MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "team",
      type: "group",
      ownerUserId: OWNER_ID,
    },
    {
      id: OTHER_MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "other",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
  ]);
}

export async function grantMember(
  db: DB,
  perms: number,
  mailboxId: string = MAILBOX_ID,
  userId: string = MEMBER_ID,
): Promise<void> {
  await db.insert(mailboxMember).values({ mailboxId, userId, perms });
}

let seq = 0;

// Insert a thread plus one inbound message; returns the ids. `seq` keeps message
// ids unique across calls within a test.
export async function seedThread(
  db: DB,
  mailboxId: string = MAILBOX_ID,
  overrides: Partial<typeof thread.$inferInsert> = {},
): Promise<{ threadId: string; messageId: string }> {
  const threadId = `thread-${++seq}`;
  const messageId = `msg-${seq}`;
  await db.insert(thread).values({
    id: threadId,
    mailboxId,
    subjectNorm: "hello",
    msgCount: 1,
    ...overrides,
  });
  await db.insert(message).values({
    id: messageId,
    mailboxId,
    threadId,
    direction: "in",
    fromAddr: "sender@elsewhere.test",
    fromName: "Sender",
    subject: "Hello",
    snippet: "Hello there",
  });
  return { threadId, messageId };
}

export async function seedContactKey(
  db: DB,
  mailboxId: string,
  email: string,
  overrides: Partial<typeof contactKey.$inferInsert> = {},
): Promise<string> {
  const id = `ck-${++seq}`;
  await db.insert(contactKey).values({
    id,
    mailboxId,
    email,
    publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----",
    fingerprint: `FPR${seq}`,
    ...overrides,
  });
  return id;
}
