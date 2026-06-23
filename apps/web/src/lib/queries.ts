import { queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";

export interface MailboxSummary {
  id: string;
  address: string;
  displayName: string | null;
  type: "personal" | "group" | "service" | "temp";
  expiresAt: string | null;
  role: "owner" | "member";
  perms: number;
  unread: number;
}

export interface ThreadRow {
  id: string;
  mailboxId: string;
  subjectNorm: string;
  lastMsgAt: string;
  msgCount: number;
  unreadCount: number;
  participants: { name?: string; address: string }[];
  trashed: boolean;
  spam: boolean;
}

export interface MessageRow {
  id: string;
  mailboxId: string;
  threadId: string;
  direction: "in" | "out";
  fromName: string | null;
  fromAddr: string;
  deliveredTo: string | null;
  toAddrs: { name?: string; address: string }[];
  subject: string;
  snippet: string;
  flags: number;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  spamVerdict: "clean" | "suspicious" | "spam" | null;
  spamReasons: string[] | null;
}

export interface MeUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  twoFactorEnabled?: boolean;
}

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api<{ user: MeUser | null }>("/api/me"),
  staleTime: 60_000,
});

export const bootstrapQuery = queryOptions({
  queryKey: ["bootstrap"],
  queryFn: () => api<{ needsBootstrap: boolean }>("/api/bootstrap"),
  staleTime: 0,
});

export const mailboxesQuery = queryOptions({
  queryKey: ["mailboxes"],
  queryFn: () => api<{ mailboxes: MailboxSummary[] }>("/api/mailboxes"),
});

export interface Contact {
  address: string;
  name?: string;
}

export const contactsQuery = queryOptions({
  queryKey: ["contacts"],
  queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  staleTime: 5 * 60_000,
});

export type MailView = "inbox" | "drafts" | "sent" | "marked" | "spam" | "trash" | "all";
export const MAIL_VIEWS: MailView[] = ["inbox", "drafts", "sent", "marked", "spam", "trash", "all"];

export function parseMailView(value: unknown): MailView {
  return MAIL_VIEWS.includes(value as MailView) ? (value as MailView) : "inbox";
}

export const threadsQuery = (mailboxId: string, view: MailView = "inbox") =>
  queryOptions({
    queryKey: ["threads", mailboxId, view],
    queryFn: () =>
      api<{ threads: ThreadRow[] }>(
        `/api/threads?mailboxId=${encodeURIComponent(mailboxId)}&view=${view}`,
      ),
    enabled: Boolean(mailboxId),
  });

export interface DraftRow {
  id: string;
  mailboxId: string;
  inReplyTo: string | null;
  references: string[] | null;
  toAddrs: { name?: string; address: string }[];
  ccAddrs: { name?: string; address: string }[] | null;
  bccAddrs: { name?: string; address: string }[] | null;
  subject: string;
  body: string;
  markdown: boolean;
  attachments: { r2Key: string; filename: string; contentType: string; sizeBytes: number }[];
  createdAt: string;
  updatedAt: string;
}

export const draftsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["drafts", mailboxId],
    queryFn: () =>
      api<{ drafts: DraftRow[] }>(`/api/drafts?mailboxId=${encodeURIComponent(mailboxId)}`),
    enabled: Boolean(mailboxId),
  });

export type FolderCounts = Record<MailView, { total: number; unread: number }>;

// Keyed under the ["threads", mailboxId] prefix so thread invalidations refresh
// the badges for free; draft mutations also invalidate this prefix.
export const folderCountsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["threads", mailboxId, "counts"],
    queryFn: () =>
      api<{ counts: FolderCounts }>(
        `/api/threads/counts?mailboxId=${encodeURIComponent(mailboxId)}`,
      ),
    enabled: Boolean(mailboxId),
  });

export const threadQuery = (threadId: string) =>
  queryOptions({
    queryKey: ["thread", threadId],
    queryFn: () => api<{ thread: ThreadRow; messages: MessageRow[] }>(`/api/threads/${threadId}`),
    enabled: Boolean(threadId),
  });

export interface SearchResult {
  messageId: string;
  threadId: string;
  mailboxId: string;
  mailboxAddress: string;
  subject: string;
  snippet: string;
  fromName: string | null;
  fromAddr: string;
  direction: "in" | "out";
  flags: number;
  receivedAt: string | null;
  sentAt: string | null;
}

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ["search", q],
    queryFn: () => api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    staleTime: 15_000,
  });

export interface LabelRow {
  id: string;
  mailboxId: string;
  name: string;
  color: string;
}

export const labelsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["labels", mailboxId],
    queryFn: () =>
      api<{ labels: LabelRow[] }>(`/api/labels?mailboxId=${encodeURIComponent(mailboxId)}`),
    enabled: Boolean(mailboxId),
  });

export interface MessageLabel {
  id: string;
  name: string;
  color: string;
}

export const messageLabelsQuery = (messageIds: string[]) =>
  queryOptions({
    queryKey: ["message-labels", messageIds.toSorted().join(",")],
    queryFn: () => {
      const qs = messageIds.map((id) => `id=${encodeURIComponent(id)}`).join("&");
      return api<{ labels: Record<string, MessageLabel[]> }>(`/api/labels/by-messages?${qs}`);
    },
    enabled: messageIds.length > 0,
  });
