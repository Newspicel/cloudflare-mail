import type { MailboxSummaryDto, MessageDto, ThreadDto } from "@cfmail/shared";
import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./query-keys.ts";

type ThreadList = { threads: ThreadDto[] };
type ThreadDetail = { thread: ThreadDto; messages: MessageDto[] };
type MailboxList = { mailboxes: MailboxSummaryDto[] };

// One place that defines "what to refresh when a thread changes" — used by both
// the SSE handler and mutation `onSettled`, so the two never drift.
export function invalidateThreadChange(
  qc: QueryClient,
  mailboxId: string,
  threadId?: string,
): void {
  qc.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
  if (threadId) qc.invalidateQueries({ queryKey: keys.thread(threadId) });
  qc.invalidateQueries({ queryKey: keys.mailboxes() });
}

// ─── Optimistic cache helpers ───────────────────────────────────────────────
//
// Snapshots cover every view list + folder counts under the mailbox so a failed
// mutation rolls back cleanly. The mutators below skip the counts cache (it has
// no `threads` array) and let `onSettled` reconcile the real numbers.

type Snapshot = [readonly unknown[], unknown][];

export function snapshotMailboxThreads(qc: QueryClient, mailboxId: string): Snapshot {
  return qc.getQueriesData({ queryKey: keys.threadsRoot(mailboxId) });
}

export function restoreSnapshot(qc: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) qc.setQueryData(key, data);
}

/** Drop threads from every cached view list for a mailbox (trash/spam/restore). */
export function removeThreadsFromLists(
  qc: QueryClient,
  mailboxId: string,
  ids: Iterable<string>,
): void {
  const idSet = new Set(ids);
  qc.setQueriesData<ThreadList>({ queryKey: keys.threadsRoot(mailboxId) }, (old) =>
    old && Array.isArray(old.threads)
      ? { ...old, threads: old.threads.filter((t) => !idSet.has(t.id)) }
      : old,
  );
}

/** Patch matching threads in every cached view list (e.g. read/unread). */
export function patchThreadsInLists(
  qc: QueryClient,
  mailboxId: string,
  ids: Iterable<string>,
  patch: Partial<ThreadDto>,
): void {
  const idSet = new Set(ids);
  qc.setQueriesData<ThreadList>({ queryKey: keys.threadsRoot(mailboxId) }, (old) =>
    old && Array.isArray(old.threads)
      ? { ...old, threads: old.threads.map((t) => (idSet.has(t.id) ? { ...t, ...patch } : t)) }
      : old,
  );
}

// ─── SSE-driven optimistic bumps ────────────────────────────────────────────
//
// Inbound events carry no timestamp, so we stamp the client clock and move the
// thread to the top for instant feedback; the follow-up invalidate replaces it
// with the server's ordering a moment later.

/** Move a thread to the front of every cached list, bumping its counts. */
export function bumpThreadToTop(
  qc: QueryClient,
  mailboxId: string,
  threadId: string,
  nowIso: string,
  incUnread: boolean,
): void {
  qc.setQueriesData<ThreadList>({ queryKey: keys.threadsRoot(mailboxId) }, (old) => {
    if (!old || !Array.isArray(old.threads)) return old;
    const idx = old.threads.findIndex((t) => t.id === threadId);
    if (idx === -1) return old;
    const t = old.threads[idx];
    if (!t) return old;
    const updated: ThreadDto = {
      ...t,
      msgCount: t.msgCount + 1,
      unreadCount: incUnread ? t.unreadCount + 1 : t.unreadCount,
      lastMsgAt: nowIso,
    };
    return {
      ...old,
      threads: [updated, ...old.threads.slice(0, idx), ...old.threads.slice(idx + 1)],
    };
  });
}

/** Nudge a mailbox's unread badge (clamped at 0) ahead of the refetch. */
export function bumpMailboxUnread(qc: QueryClient, mailboxId: string, delta: number): void {
  qc.setQueryData<MailboxList>(keys.mailboxes(), (old) =>
    old
      ? {
          mailboxes: old.mailboxes.map((m) =>
            m.id === mailboxId ? { ...m, unread: Math.max(0, m.unread + delta) } : m,
          ),
        }
      : old,
  );
}

/** Optimistically rewrite a single message's flags in the open thread detail. */
export function patchMessageFlags(
  qc: QueryClient,
  threadId: string,
  messageId: string,
  flags: number,
): void {
  qc.setQueryData<ThreadDetail>(keys.thread(threadId), (old) =>
    old
      ? { ...old, messages: old.messages.map((m) => (m.id === messageId ? { ...m, flags } : m)) }
      : old,
  );
}
