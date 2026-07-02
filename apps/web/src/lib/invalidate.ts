import type { MailboxSummaryDto, MessageDto, ThreadDto } from "@cfmail/shared";
import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./query-keys.ts";

type ThreadList = { threads: ThreadDto[] };
type ThreadPages = { pages: { threads: ThreadDto[]; nextCursor?: string | null }[] };
type ThreadDetail = { thread: ThreadDto; messages: MessageDto[] };
type MailboxList = { mailboxes: MailboxSummaryDto[] };

// Thread lists are infinite queries (`{ pages: [{ threads }] }`), but the same
// `threadsRoot` prefix also caches the folder-counts object (no `threads`). This
// applies `fn` to every page's thread array and leaves non-list caches untouched,
// so one mutator works across both shapes without knowing which it got.
function mapThreadCache<T>(old: T, fn: (threads: ThreadDto[]) => ThreadDto[]): T {
  const o = old as unknown as Partial<ThreadPages & ThreadList>;
  if (Array.isArray(o?.pages)) {
    return { ...o, pages: o.pages.map((p) => ({ ...p, threads: fn(p.threads) })) } as T;
  }
  if (Array.isArray(o?.threads)) return { ...o, threads: fn(o.threads) } as T;
  return old;
}

// One place that defines "what to refresh when a thread changes" — used by both
// the SSE handler and mutation `onSettled`, so the two never drift. Callers say
// what actually changed so an in-place metadata update doesn't refetch the whole
// mailbox tree.
export interface ThreadChangeScope {
  mailboxId: string;
  /** Open thread detail to refresh. */
  threadId?: string;
  /** Unread state changed — refresh the mailbox badges in the sidebar. */
  counts?: boolean;
  /** Folder membership, counts, or list rows may have shifted. */
  folders?: boolean;
}

interface PendingThreadChanges {
  mailboxIds: Set<string>;
  threadIds: Set<string>;
  counts: boolean;
  folders: boolean;
}

function emptyPending(): PendingThreadChanges {
  return { mailboxIds: new Set(), threadIds: new Set(), counts: false, folders: false };
}

function applyThreadChanges(qc: QueryClient, p: PendingThreadChanges): void {
  const roots = new Set(p.mailboxIds);
  // The combined "All" view caches under a separate "all" root, so a per-mailbox
  // change has to nudge it too (no-op if that view isn't mounted).
  if ([...p.mailboxIds].some((id) => id !== "all")) roots.add("all");
  for (const id of roots) qc.invalidateQueries({ queryKey: keys.threadsRoot(id) });
  for (const id of p.threadIds) qc.invalidateQueries({ queryKey: keys.thread(id) });
  if (p.counts) qc.invalidateQueries({ queryKey: keys.mailboxes() });
  if (p.folders) {
    // Custom folders share threads with the mailbox views: refresh the sidebar
    // list + folder views when membership/counts can have shifted.
    qc.invalidateQueries({ queryKey: keys.folders() });
    qc.invalidateQueries({ queryKey: keys.folderThreadsRoot() });
  }
}

export function invalidateThreadChange(qc: QueryClient, scope: ThreadChangeScope): void {
  applyThreadChanges(qc, {
    mailboxIds: new Set([scope.mailboxId]),
    threadIds: new Set(scope.threadId ? [scope.threadId] : []),
    counts: scope.counts ?? false,
    folders: scope.folders ?? false,
  });
}

// Trailing-window batcher for SSE-driven invalidation: N events in a burst of
// incoming mail merge into one refetch cycle instead of one per message.
export function createThreadChangeCoalescer(
  qc: QueryClient,
  delayMs = 1500,
): { push: (scope: ThreadChangeScope) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = emptyPending();
  const flush = () => {
    timer = null;
    const p = pending;
    pending = emptyPending();
    applyThreadChanges(qc, p);
  };
  return {
    push(scope) {
      pending.mailboxIds.add(scope.mailboxId);
      if (scope.threadId) pending.threadIds.add(scope.threadId);
      pending.counts ||= scope.counts ?? false;
      pending.folders ||= scope.folders ?? false;
      timer ??= setTimeout(flush, delayMs);
    },
    dispose() {
      if (!timer) return;
      clearTimeout(timer);
      flush();
    },
  };
}

/** Drop threads from a single cached folder thread-list (file/unfile). */
export function removeThreadsFromFolder(
  qc: QueryClient,
  folderId: string,
  ids: Iterable<string>,
): void {
  const idSet = new Set(ids);
  qc.setQueryData(keys.folderThreads(folderId), (old) =>
    old ? mapThreadCache(old, (threads) => threads.filter((t) => !idSet.has(t.id))) : old,
  );
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
  qc.setQueriesData({ queryKey: keys.threadsRoot(mailboxId) }, (old) =>
    old ? mapThreadCache(old, (threads) => threads.filter((t) => !idSet.has(t.id))) : old,
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
  qc.setQueriesData({ queryKey: keys.threadsRoot(mailboxId) }, (old) =>
    old
      ? mapThreadCache(old, (threads) =>
          threads.map((t) => (idSet.has(t.id) ? { ...t, ...patch } : t)),
        )
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
  const bump = (t: ThreadDto): ThreadDto => ({
    ...t,
    msgCount: t.msgCount + 1,
    unreadCount: incUnread ? t.unreadCount + 1 : t.unreadCount,
    lastMsgAt: nowIso,
  });
  // Pull the thread out of wherever it sits (any page) and prepend the bumped
  // copy to the very first page so it lands at the top of the rendered list.
  qc.setQueriesData({ queryKey: keys.threadsRoot(mailboxId) }, (old) => {
    let found: ThreadDto | undefined;
    const without = mapThreadCache(old as ThreadList | ThreadPages, (threads) =>
      threads.filter((t) => {
        if (t.id !== threadId) return true;
        found = t;
        return false;
      }),
    );
    if (!found) return old;
    const w = without as Partial<ThreadPages & ThreadList>;
    if (Array.isArray(w.pages)) {
      const [first, ...rest] = w.pages;
      return {
        ...w,
        pages: [{ ...first, threads: [bump(found), ...(first?.threads ?? [])] }, ...rest],
      };
    }
    if (Array.isArray(w.threads)) return { ...w, threads: [bump(found), ...w.threads] };
    return old;
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

/** Drop a single message from the open thread detail (per-message delete). */
export function removeMessageFromThread(
  qc: QueryClient,
  threadId: string,
  messageId: string,
): void {
  qc.setQueryData<ThreadDetail>(keys.thread(threadId), (old) =>
    old ? { ...old, messages: old.messages.filter((m) => m.id !== messageId) } : old,
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
