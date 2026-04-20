import type { DB } from "@cfmail/db";
import { mailbox, mailboxMember } from "@cfmail/db/schema";
import { ALL_PERMS, has, type PermBit } from "@cfmail/shared/permissions";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

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
