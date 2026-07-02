import type { DB } from "@cfmail/db";
import { mailbox } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";

// Flag a mailbox for background purge. The cron's purgePendingMailboxes drains
// its threads (and their blobs) in bounded batches, then finalizes: "empty"
// clears the flag, "delete" drops the mailbox row. Every mailbox deletion goes
// through this — a synchronous cascade-delete of a large mailbox exceeds D1's
// per-statement limits and loads every blob key into memory. A delete-pending
// mailbox reads as gone immediately (mailboxNotDeletePending / resolveAccess).
export async function markMailboxPurge(
  db: DB,
  mailboxId: string,
  mode: "empty" | "delete",
): Promise<void> {
  await db.update(mailbox).set({ pendingPurge: mode }).where(eq(mailbox.id, mailboxId));
}
