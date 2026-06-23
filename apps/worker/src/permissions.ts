import type { DB } from "@cfmail/db";
import { mailbox, mailboxMember } from "@cfmail/db/schema";
import { ALL_PERMS, has, type PermBit } from "@cfmail/shared/permissions";
import { and, eq, ne } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

// Sentinel mailbox id for the combined "All" view. Real ids are UUIDs, so this
// can never collide. Used by the threads/drafts list endpoints to aggregate
// across every mailbox the user can read instead of a single one.
export const ALL_MAILBOXES = "all";

export interface MailboxAccess {
  mailboxId: string;
  userId: string;
  perms: number;
  isOwner: boolean;
}

export async function resolveAccess(
  db: DB,
  userId: string,
  mailboxId: string,
): Promise<MailboxAccess | null> {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, mailboxId),
    columns: { id: true, ownerUserId: true },
  });
  if (!mb) return null;
  if (mb.ownerUserId === userId) {
    return { mailboxId, userId, perms: ALL_PERMS, isOwner: true };
  }
  const member = await db.query.mailboxMember.findFirst({
    where: and(eq(mailboxMember.mailboxId, mailboxId), eq(mailboxMember.userId, userId)),
    columns: { perms: true },
  });
  if (!member) return null;
  return { mailboxId, userId, perms: member.perms, isOwner: false };
}

// Every non-service mailbox the user can read (owned + member). Backs the
// combined "All" view; service mailboxes are key-driven and never user-facing.
export async function accessibleMailboxIds(db: DB, userId: string): Promise<string[]> {
  const owned = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(and(eq(mailbox.ownerUserId, userId), ne(mailbox.type, "service")));
  const member = await db
    .select({ id: mailboxMember.mailboxId })
    .from(mailboxMember)
    .innerJoin(mailbox, eq(mailboxMember.mailboxId, mailbox.id))
    .where(and(eq(mailboxMember.userId, userId), ne(mailbox.type, "service")));
  return [...new Set([...owned.map((r) => r.id), ...member.map((r) => r.id)])];
}

export async function requirePerm(
  db: DB,
  userId: string,
  mailboxId: string,
  bit: PermBit,
): Promise<MailboxAccess> {
  const access = await resolveAccess(db, userId, mailboxId);
  if (!access || !has(access.perms, bit)) {
    throw new HTTPException(403, { message: "forbidden" });
  }
  return access;
}
