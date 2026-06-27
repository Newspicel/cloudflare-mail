import type { DB } from "@cfmail/db";
import { mailbox, mailboxMember } from "@cfmail/db/schema";
import { ALL_PERMS, has, type PermBit } from "@cfmail/shared/permissions";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";

// Reusable predicates over the mailbox purge marker (schema: pending_purge).
// `notPurging` excludes both empty- and delete-pending mailboxes (no live
// content to show); `notDeletePending` only hides mailboxes being hard-deleted
// (their address is considered freed) while empty-pending ones stay listed.
export const mailboxNotPurging = isNull(mailbox.pendingPurge);
export const mailboxNotDeletePending = or(
  isNull(mailbox.pendingPurge),
  ne(mailbox.pendingPurge, "delete"),
);

// Sentinel mailbox id for the combined "All" view. Real ids are UUIDs, so this
// can never collide. Used by the threads/drafts list endpoints to aggregate
// across every mailbox the user can read instead of a single one.
export const ALL_MAILBOXES = "all";

export interface MailboxAccess {
  mailboxId: string;
  userId: string;
  perms: number;
  isOwner: boolean;
  // Mailbox is being emptied in the background — it still resolves (the user can
  // open it) but its threads should read as already gone.
  purging: boolean;
}

export async function resolveAccess(
  db: DB,
  userId: string,
  mailboxId: string,
): Promise<MailboxAccess | null> {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, mailboxId),
    columns: { id: true, ownerUserId: true, pendingPurge: true },
  });
  if (!mb) return null;
  // A hard-delete in progress: treat the mailbox as already gone.
  if (mb.pendingPurge === "delete") return null;
  const purging = mb.pendingPurge != null;
  if (mb.ownerUserId === userId) {
    return { mailboxId, userId, perms: ALL_PERMS, isOwner: true, purging };
  }
  const member = await db.query.mailboxMember.findFirst({
    where: and(eq(mailboxMember.mailboxId, mailboxId), eq(mailboxMember.userId, userId)),
    columns: { perms: true },
  });
  if (!member) return null;
  return { mailboxId, userId, perms: member.perms, isOwner: false, purging };
}

// Every non-service mailbox the user can read (owned + member). Backs the
// combined "All" view; service mailboxes are key-driven and never user-facing.
export async function accessibleMailboxIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: mailbox.id })
    .from(mailbox)
    .leftJoin(
      mailboxMember,
      and(eq(mailboxMember.mailboxId, mailbox.id), eq(mailboxMember.userId, userId)),
    )
    .where(
      and(
        or(eq(mailbox.ownerUserId, userId), eq(mailboxMember.userId, userId)),
        ne(mailbox.type, "service"),
        mailboxNotPurging,
      ),
    );
  return rows.map((r) => r.id);
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

// Load a mailbox-scoped entity by id, 404 if missing, then enforce mailbox
// RBAC — the "lookup → 404 → requirePerm" shape that backed every mutating
// mailbox route. Funnelling it here keeps the permission choke-point
// (invariant 2) impossible to skip and 404 messages uniform. Returns the full
// row so callers don't re-fetch.
export async function requireEntityAccess<
  T extends SQLiteTable & { id: SQLiteColumn; mailboxId: SQLiteColumn },
>(db: DB, userId: string, table: T, id: string, bit: PermBit): Promise<T["$inferSelect"]> {
  const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
  const row = rows[0] as T["$inferSelect"] | undefined;
  if (!row) throw new HTTPException(404, { message: "not found" });
  await requirePerm(db, userId, (row as { mailboxId: string }).mailboxId, bit);
  return row;
}
