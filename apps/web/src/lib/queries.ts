import type {
  ContactDto,
  DraftDto,
  FolderCountsDto,
  LabelDto,
  MailboxSummaryDto,
  MailView,
  MessageBodyDto,
  MessageDto,
  MessageLabelDto,
  MeUserDto,
  SearchFilters,
  SearchResultDto,
  SearchResultsDto,
  ThreadDto,
} from "@cfmail/shared";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys } from "./query-keys.ts";

// Response models are owned by `@cfmail/shared` (single source of truth, derived
// from the DB schema). Re-exported here under the names the UI already uses so
// call sites stay put.
export type {
  ContactDto as Contact,
  DraftDto as DraftRow,
  FolderCountsDto as FolderCounts,
  LabelDto as LabelRow,
  MailboxSummaryDto as MailboxSummary,
  MailView,
  MessageDto as MessageRow,
  MessageLabelDto as MessageLabel,
  MeUserDto as MeUser,
  SearchFilters,
  SearchResultDto as SearchResult,
  ThreadDto as ThreadRow,
};

export const meQuery = queryOptions({
  queryKey: keys.me(),
  queryFn: () => api<{ user: MeUserDto | null }>("/api/me"),
  staleTime: 60_000,
});

export const bootstrapQuery = queryOptions({
  queryKey: keys.bootstrap(),
  queryFn: () => api<{ needsBootstrap: boolean }>("/api/bootstrap"),
  staleTime: 0,
});

export const mailboxesQuery = queryOptions({
  queryKey: keys.mailboxes(),
  queryFn: () => api<{ mailboxes: MailboxSummaryDto[] }>("/api/mailboxes"),
});

export const contactsQuery = queryOptions({
  queryKey: keys.contacts(),
  queryFn: () => api<{ contacts: ContactDto[] }>("/api/contacts"),
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

export const threadsQuery = (mailboxId: string, view: MailView = "inbox") =>
  queryOptions({
    queryKey: keys.threads(mailboxId, view),
    queryFn: () =>
      api<{ threads: ThreadDto[] }>(
        `/api/threads?mailboxId=${encodeURIComponent(mailboxId)}&view=${view}`,
      ),
    enabled: Boolean(mailboxId),
  });

export const draftsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.drafts(mailboxId),
    queryFn: () =>
      api<{ drafts: DraftDto[] }>(`/api/drafts?mailboxId=${encodeURIComponent(mailboxId)}`),
    enabled: Boolean(mailboxId),
  });

// Keyed under the threads-root prefix so thread invalidations refresh the badges
// for free; draft mutations also invalidate this prefix.
export const folderCountsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.folderCounts(mailboxId),
    queryFn: () =>
      api<{ counts: FolderCountsDto }>(
        `/api/threads/counts?mailboxId=${encodeURIComponent(mailboxId)}`,
      ),
    enabled: Boolean(mailboxId),
  });

export const threadQuery = (threadId: string) =>
  queryOptions({
    queryKey: keys.thread(threadId),
    queryFn: () => api<{ thread: ThreadDto; messages: MessageDto[] }>(`/api/threads/${threadId}`),
    enabled: Boolean(threadId),
  });

// Full body, parsed on demand from the raw `.eml`. Immutable per message, so it
// never goes stale once fetched.
export const messageBodyQuery = (messageId: string) =>
  queryOptions({
    queryKey: keys.messageBody(messageId),
    queryFn: () => api<MessageBodyDto>(`/api/messages/${messageId}/body`),
    enabled: Boolean(messageId),
    staleTime: Number.POSITIVE_INFINITY,
  });

export type SearchFilterInput = Partial<SearchFilters>;

// Serialize a filter set into a stable query string (omitting defaults), shared
// by the cache key and the request URL so identical filters hit the cache.
export function buildSearchParams(f: SearchFilterInput): string {
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
    queryFn: () => api<SearchResultsDto>(`/api/search?${qs}`),
    enabled: hasSearchCriteria(filters),
    staleTime: 15_000,
  });
};

export const labelsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.labels(mailboxId),
    queryFn: () =>
      api<{ labels: LabelDto[] }>(`/api/labels?mailboxId=${encodeURIComponent(mailboxId)}`),
    enabled: Boolean(mailboxId),
  });

export const messageLabelsQuery = (messageIds: string[]) =>
  queryOptions({
    queryKey: keys.messageLabels(messageIds.toSorted().join(",")),
    queryFn: () => {
      const qs = messageIds.map((id) => `id=${encodeURIComponent(id)}`).join("&");
      return api<{ labels: Record<string, MessageLabelDto[]> }>(`/api/labels/by-messages?${qs}`);
    },
    enabled: messageIds.length > 0,
  });
