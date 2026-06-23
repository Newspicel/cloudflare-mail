import type { MailView } from "@cfmail/shared";

// Central registry of React Query keys. Importing these instead of writing
// `["threads", mailboxId]` inline keeps invalidation and reads in lockstep —
// rename a key once here and every call site follows.
//
// The thread/draft/label badge counts live under the `["threads", mailboxId]`
// prefix on purpose: invalidating `threadsRoot` refreshes every view list plus
// the folder counts in one call.
export const keys = {
  me: () => ["me"] as const,
  bootstrap: () => ["bootstrap"] as const,
  mailboxes: () => ["mailboxes"] as const,
  contacts: () => ["contacts"] as const,
  /** Prefix matching every thread view + folder counts for a mailbox. */
  threadsRoot: (mailboxId: string) => ["threads", mailboxId] as const,
  threads: (mailboxId: string, view: MailView) => ["threads", mailboxId, view] as const,
  folderCounts: (mailboxId: string) => ["threads", mailboxId, "counts"] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
  messageBody: (messageId: string) => ["message-body", messageId] as const,
  drafts: (mailboxId: string) => ["drafts", mailboxId] as const,
  search: (q: string) => ["search", q] as const,
  labels: (mailboxId: string) => ["labels", mailboxId] as const,
  messageLabels: (idsKey: string) => ["message-labels", idsKey] as const,
  /** Prefix matching every message-labels query. */
  messageLabelsRoot: () => ["message-labels"] as const,
};
