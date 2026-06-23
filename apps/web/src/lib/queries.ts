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
  SearchResultDto,
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

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: keys.search(q),
    queryFn: () => api<{ results: SearchResultDto[] }>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    staleTime: 15_000,
  });

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
