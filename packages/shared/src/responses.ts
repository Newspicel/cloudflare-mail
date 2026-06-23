// Single source of truth for API *response* shapes. Input schemas live in
// `schemas.ts`; these describe what handlers return so the worker and the web
// app never redefine the same model twice.
//
// Raw-row responses derive straight from the Drizzle table types via type-only
// imports (erased from the browser bundle). The one twist: `c.json()` serializes
// `Date` columns to ISO strings over the wire, so `Serialized<T>` maps every
// `Date` field to `string`. The worker's serializers (api/serialize.ts) are
// typed to return these, so a schema change that breaks the shape is a compile
// error on both sides.

import type { draft, label, message, thread } from "@cfmail/db/schema";

/** Map Drizzle `Date` columns to the `string` form `c.json()` actually sends. */
export type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : [T[K]] extends [Date | null] ? string | null : T[K];
};

// ─── Raw-row DTOs ───────────────────────────────────────────────────────────

export type ThreadDto = Serialized<typeof thread.$inferSelect>;
export type MessageDto = Serialized<typeof message.$inferSelect>;
export type DraftDto = Serialized<typeof draft.$inferSelect>;
export type LabelDto = typeof label.$inferSelect; // no date columns

// ─── Computed / mapped DTOs ─────────────────────────────────────────────────

export interface MailboxSummaryDto {
  id: string;
  address: string;
  displayName: string | null;
  type: "personal" | "group" | "service" | "temp";
  expiresAt: string | null;
  role: "owner" | "member";
  perms: number;
  unread: number;
}

export interface SearchResultDto {
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

export interface ContactDto {
  address: string;
  name?: string;
}

export interface MeUserDto {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  twoFactorEnabled?: boolean;
}

export interface MessageLabelDto {
  id: string;
  name: string;
  color: string;
}

/** Full message body, parsed on demand from the raw `.eml` in R2. */
export interface MessageBodyDto {
  html: string | null;
  text: string | null;
}

export type MailView = "inbox" | "drafts" | "sent" | "marked" | "spam" | "trash" | "all";
export type FolderCountsDto = Record<MailView, { total: number; unread: number }>;

// ─── Response envelopes (used by handlers via `satisfies`) ──────────────────

export interface ThreadListDto {
  threads: ThreadDto[];
}
export interface ThreadDetailDto {
  thread: ThreadDto;
  messages: MessageDto[];
}
export interface FolderCountsResponseDto {
  counts: FolderCountsDto;
}
export interface MailboxListDto {
  mailboxes: MailboxSummaryDto[];
}
export interface DraftListDto {
  drafts: DraftDto[];
}
export interface DraftDetailDto {
  draft: DraftDto;
}
export interface LabelListDto {
  labels: LabelDto[];
}
export interface MessageLabelsDto {
  labels: Record<string, MessageLabelDto[]>;
}
export interface SearchResultsDto {
  results: SearchResultDto[];
}
export interface ContactsDto {
  contacts: ContactDto[];
}
export interface MeDto {
  user: MeUserDto | null;
}
