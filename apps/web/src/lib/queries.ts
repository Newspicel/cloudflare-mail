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
}

export interface ThreadRow {
  id: string;
  mailboxId: string;
  subjectNorm: string;
  lastMsgAt: string;
  msgCount: number;
  unreadCount: number;
  participants: { name?: string; address: string }[];
  archived: boolean;
  trashed: boolean;
}

export interface MessageRow {
  id: string;
  mailboxId: string;
  threadId: string;
  direction: "in" | "out";
  fromName: string | null;
  fromAddr: string;
  toAddrs: { name?: string; address: string }[];
  subject: string;
  snippet: string;
  flags: number;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api<{ user: { id: string; name: string; email: string } | null }>("/api/me"),
  staleTime: 60_000,
});

export const mailboxesQuery = queryOptions({
  queryKey: ["mailboxes"],
  queryFn: () => api<{ mailboxes: MailboxSummary[] }>("/api/mailboxes"),
});

export const threadsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["threads", mailboxId],
    queryFn: () => api<{ threads: ThreadRow[] }>(`/api/threads?mailboxId=${mailboxId}`),
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
