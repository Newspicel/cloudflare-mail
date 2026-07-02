import type {
  ContactDto,
  DraftDto,
  FolderCountsDto,
  FolderDto,
  LabelDto,
  MailboxSummaryDto,
  MailView,
  MessageDto,
  MessageLabelDto,
  MeUserDto,
  RuleDto,
  SearchFilters,
  SearchResultDto,
  ThreadDto,
} from "@cfmail/shared";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { rpc, unwrap } from "./api.ts";
import { keys } from "./query-keys.ts";

// Response models are owned by `@cfmail/shared` (single source of truth, derived
// from the DB schema). Re-exported here under the names the UI already uses so
// call sites stay put. Requests themselves go through the typed RPC client
// (`rpc`), so paths and response bodies are checked against the worker's routes.
export type {
  ContactDto as Contact,
  DraftDto as DraftRow,
  FolderCountsDto as FolderCounts,
  FolderDto as FolderRow,
  LabelDto as LabelRow,
  MailboxSummaryDto as MailboxSummary,
  MailView,
  MessageDto as MessageRow,
  MessageLabelDto as MessageLabel,
  MeUserDto as MeUser,
  RuleDto as RuleRow,
  SearchFilters,
  SearchResultDto as SearchResult,
  ThreadDto as ThreadRow,
};

export const meQuery = queryOptions({
  queryKey: keys.me(),
  queryFn: () => unwrap(rpc.me.$get()),
  staleTime: 60_000,
});

export const bootstrapQuery = queryOptions({
  queryKey: keys.bootstrap(),
  queryFn: () => unwrap(rpc.bootstrap.$get()),
  staleTime: 0,
});

export const mailboxesQuery = queryOptions({
  queryKey: keys.mailboxes(),
  queryFn: () => unwrap(rpc.mailboxes.$get()),
});

export const contactsQuery = queryOptions({
  queryKey: keys.contacts(),
  queryFn: () => unwrap(rpc.contacts.$get()),
  staleTime: 5 * 60_000,
});

// Sentinel mailbox id for the combined "All" view — the worker aggregates every
// mailbox the user can read behind it. Mirrors the backend constant of the same
// name; real ids are UUIDs so it never collides.
export const ALL_MAILBOXES = "all";

export const MAIL_VIEWS: MailView[] = ["inbox", "drafts", "sent", "marked", "spam", "trash", "all"];

export function parseMailView(value: unknown): MailView {
  return MAIL_VIEWS.includes(value as MailView) ? (value as MailView) : "inbox";
}

// Page size for the infinite thread lists. The worker caps at 200; 50 keeps the
// first paint light while still filling a tall viewport in one fetch.
const THREAD_PAGE = 50;

export const threadsQuery = (mailboxId: string, view: MailView = "inbox") =>
  infiniteQueryOptions({
    queryKey: keys.threads(mailboxId, view),
    queryFn: ({ pageParam }) =>
      unwrap(
        rpc.threads.$get({
          query: {
            mailboxId,
            view,
            limit: String(THREAD_PAGE),
            cursor: pageParam ?? undefined,
          },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(mailboxId),
    staleTime: 30_000,
  });

export const draftsQuery = (mailboxId: string) =>
  infiniteQueryOptions({
    queryKey: keys.drafts(mailboxId),
    queryFn: ({ pageParam }) =>
      unwrap(
        rpc.drafts.$get({
          query: { mailboxId, limit: String(THREAD_PAGE), cursor: pageParam ?? undefined },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(mailboxId),
  });

// A single draft by id — used by the standalone pop-out compose window, which
// loads fresh and rehydrates from the server-persisted draft.
export const draftQuery = (draftId: string) =>
  queryOptions({
    queryKey: keys.draft(draftId),
    queryFn: () => unwrap(rpc.drafts[":id"].$get({ param: { id: draftId } })),
    enabled: Boolean(draftId),
  });

// Keyed under the threads-root prefix so thread invalidations refresh the badges
// for free; draft mutations also invalidate this prefix.
export const folderCountsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.folderCounts(mailboxId),
    queryFn: () => unwrap(rpc.threads.counts.$get({ query: { mailboxId } })),
    enabled: Boolean(mailboxId),
  });

export const threadQuery = (threadId: string) =>
  queryOptions({
    queryKey: keys.thread(threadId),
    queryFn: () => unwrap(rpc.threads[":id"].$get({ param: { id: threadId } })),
    enabled: Boolean(threadId),
  });

// Full body, parsed on demand from the raw `.eml`. Immutable per message, so it
// never goes stale once fetched.
export const messageBodyQuery = (messageId: string) =>
  queryOptions({
    queryKey: keys.messageBody(messageId),
    queryFn: () => unwrap(rpc.messages[":id"].body.$get({ param: { id: messageId } })),
    enabled: Boolean(messageId),
    staleTime: Number.POSITIVE_INFINITY,
  });

export type SearchFilterInput = Partial<SearchFilters>;

// Serialize a filter set into a stable query string (omitting defaults), shared
// by the cache key and the request URL so identical filters hit the cache.
function buildSearchParams(f: SearchFilterInput): string {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.searchIn && f.searchIn !== "all") p.set("searchIn", f.searchIn);
  if (f.from?.trim()) p.set("from", f.from.trim());
  if (f.to?.trim()) p.set("to", f.to.trim());
  if (f.subject?.trim()) p.set("subject", f.subject.trim());
  if (f.exclude?.trim()) p.set("exclude", f.exclude.trim());
  if (f.after) p.set("after", f.after);
  if (f.before) p.set("before", f.before);
  if (f.direction) p.set("direction", f.direction);
  if (f.hasAttachment) p.set("hasAttachment", "true");
  if (f.folder && f.folder !== "any") p.set("folder", f.folder);
  if (f.mailboxId && f.mailboxId !== "all") p.set("mailboxId", f.mailboxId);
  if (f.page) p.set("page", String(f.page));
  if (f.limit) p.set("limit", String(f.limit));
  return p.toString();
}

// True when the filter set carries at least one real search criterion (so a
// blank page doesn't fire a request, but a metadata-only search like
// "folder=spam" does).
export function hasSearchCriteria(f: SearchFilterInput): boolean {
  return Boolean(
    f.q?.trim() ||
      f.from?.trim() ||
      f.to?.trim() ||
      f.subject?.trim() ||
      f.exclude?.trim() ||
      f.after ||
      f.before ||
      f.direction ||
      f.hasAttachment ||
      (f.folder && f.folder !== "any"),
  );
}

export const searchQuery = (filters: SearchFilterInput) => {
  const qs = buildSearchParams(filters);
  return queryOptions({
    queryKey: keys.search(qs),
    queryFn: () => unwrap(rpc.search.$get({ query: Object.fromEntries(new URLSearchParams(qs)) })),
    enabled: hasSearchCriteria(filters),
    staleTime: 15_000,
  });
};

export const labelsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.labels(mailboxId),
    queryFn: () => unwrap(rpc.labels.$get({ query: { mailboxId } })),
    enabled: Boolean(mailboxId),
    staleTime: 5 * 60_000,
  });

export const rulesQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.rules(mailboxId),
    queryFn: () => unwrap(rpc.rules.$get({ query: { mailboxId } })),
    enabled: Boolean(mailboxId),
    staleTime: 5 * 60_000,
  });

export const foldersQuery = queryOptions({
  queryKey: keys.folders(),
  queryFn: () => unwrap(rpc.folders.$get()),
  staleTime: 5 * 60_000,
});

export const folderThreadsQuery = (folderId: string) =>
  infiniteQueryOptions({
    queryKey: keys.folderThreads(folderId),
    queryFn: ({ pageParam }) =>
      unwrap(
        rpc.folders[":id"].threads.$get({
          param: { id: folderId },
          query: { limit: String(THREAD_PAGE), cursor: pageParam ?? undefined },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(folderId),
  });

export const messageLabelsQuery = (messageIds: string[]) =>
  queryOptions({
    queryKey: keys.messageLabels(messageIds.toSorted().join(",")),
    queryFn: () => unwrap(rpc.labels["by-messages"].$get({ query: { id: messageIds } })),
    enabled: messageIds.length > 0,
  });

// Distinct labels per thread, for the chips on list rows. Keyed by the full id
// set so a list reuses one request instead of one per row.
export const threadLabelsQuery = (threadIds: string[]) =>
  queryOptions({
    queryKey: keys.threadLabels(threadIds.toSorted().join(",")),
    queryFn: () => unwrap(rpc.labels["by-threads"].$get({ query: { id: threadIds } })),
    enabled: threadIds.length > 0,
    staleTime: 15_000,
  });
