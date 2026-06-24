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

import type {
  ContactKeySource,
  MailboxType,
  MessageDirection,
  PgpMode,
  SpamFilterLevel,
  UserRole,
} from "@cfmail/db/enums";
import type {
  draft,
  folder,
  label,
  message,
  RuleAction,
  RuleCondition,
  rule,
  thread,
} from "@cfmail/db/schema";

// Re-exported so the web app gets the rule JSON shapes without importing @cfmail/db.
export type { RuleAction, RuleCondition };

/** Map Drizzle `Date` columns to the `string` form `c.json()` actually sends. */
export type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : [T[K]] extends [Date | null] ? string | null : T[K];
};

// ─── Raw-row DTOs ───────────────────────────────────────────────────────────

export type ThreadDto = Serialized<typeof thread.$inferSelect>;
export type MessageDto = Serialized<typeof message.$inferSelect>;
// The resolved outbound payload + attempt counter stay server-side — drafts only
// expose `scheduledFor` (pending) and `scheduledError` (terminal failure) so the
// UI can show/cancel/flag a scheduled send.
export type DraftDto = Omit<
  Serialized<typeof draft.$inferSelect>,
  "scheduledPayload" | "scheduledAttempts"
>;
export type LabelDto = typeof label.$inferSelect; // no date columns

/** An inbound rule; `conditions`/`actions` keep their typed JSON shape. */
export type RuleDto = Serialized<typeof rule.$inferSelect>;

/** A custom folder plus its live thread counts (total + unread). */
export type FolderDto = Serialized<typeof folder.$inferSelect> & {
  total: number;
  unread: number;
};

// ─── Computed / mapped DTOs ─────────────────────────────────────────────────

export interface MailboxSummaryDto {
  id: string;
  address: string;
  displayName: string | null;
  type: MailboxType;
  expiresAt: string | null;
  role: "owner" | "member";
  perms: number;
  unread: number;
  pgpMode: PgpMode;
  /** Whether reader AI features (summaries, smart reply, thread summary) are on. */
  aiFeatures: boolean;
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
  direction: MessageDirection;
  flags: number;
  hasAttachments: boolean;
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
  image?: string | null;
  role: UserRole;
  twoFactorEnabled?: boolean;
  /** Raw JSON string of UserPrefs (see parseUserPrefs). */
  preferences?: string | null;
}

/** App-level, per-user preferences. Stored as a JSON string on the user row. */
export interface UserPrefs {
  // reading & display
  density?: "comfortable" | "compact";
  defaultView?: MailView;
  autoMarkRead?: boolean;
  // compose
  composeInNewWindow?: boolean;
  composeDefaultMode?: "text" | "markdown" | "html";
  sendShortcut?: boolean;
  replyAllDefault?: boolean;
  // date & time
  dateFormat?: DateFormat;
  timeFormat?: "12h" | "24h";
  // which maps service event/address links open in ("auto" picks by device)
  mapProvider?: "auto" | "google" | "apple";
  // show the AI summary line under each row in the list (default on when the
  // mailbox has AI features enabled). Purely a display toggle — no spend impact.
  aiSummaries?: boolean;
}

/**
 * Explicit date layouts (order + separator + numeric/named month + year width),
 * not country presets. Rendered by lib/time.ts. Examples assume 2026-06-24:
 *   dmy-dot   24.06.2026   dmy-dot-2   24.06.26
 *   dmy-slash 24/06/2026   dmy-slash-2 24/06/26
 *   mdy-slash 06/24/2026   mdy-slash-2 06/24/26
 *   iso       2026-06-24
 *   d-mon-y   24 Jun 2026  d-month-y   24 June 2026
 *   mon-d-y   Jun 24, 2026 month-d-y   June 24, 2026
 */
export type DateFormat =
  | "dmy-dot"
  | "dmy-dot-2"
  | "dmy-slash"
  | "dmy-slash-2"
  | "mdy-slash"
  | "mdy-slash-2"
  | "iso"
  | "d-mon-y"
  | "d-month-y"
  | "mon-d-y"
  | "month-d-y";

/** Parse the raw `preferences` JSON string into a typed object; never throws. */
export function parseUserPrefs(raw: string | null | undefined): UserPrefs {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as UserPrefs) : {};
  } catch {
    return {};
  }
}

export interface MessageLabelDto {
  id: string;
  name: string;
  color: string;
}

/** A stored attachment's metadata (bytes are fetched from the `/raw` route). */
export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Inline (cid) part embedded in the HTML body rather than a real attachment. */
  inline: boolean;
  contentId: string | null;
}

/** One participant of a calendar invite (organizer or attendee). */
export interface CalendarPersonDto {
  name: string | null;
  email: string | null;
  /** RFC 5545 PARTSTAT (NEEDS-ACTION/ACCEPTED/DECLINED/…); attendees only. */
  status: string | null;
}

/**
 * A calendar invite (RFC 5545 VEVENT) carried by a message, surfaced for the
 * event banner. `start`/`end` are strings `new Date()` can parse; `allDay`
 * means a date-only event. Display-only — we don't manage calendars.
 */
export interface CalendarEventDto {
  /** Calendar METHOD: REQUEST (invite), REPLY, CANCEL, PUBLISH, … */
  method: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  organizer: CalendarPersonDto | null;
  attendees: CalendarPersonDto[];
  /** Raw RRULE when the event recurs (presence ⇒ "Repeats"). */
  rrule: string | null;
}

/** Full message body, parsed on demand from the raw `.eml` in R2. */
export interface MessageBodyDto {
  html: string | null;
  text: string | null;
  attachments: AttachmentDto[];
  /** Present when the message carries an iCalendar invite. */
  calendar?: CalendarEventDto | null;
}

/**
 * Outcome of a List-Unsubscribe action. `unsubscribed` = handled server-side (an
 * RFC 8058 one-click POST or a mailto request was sent). `open` = the only target
 * is an https page the client must open in a new tab (carries `url`).
 */
export interface UnsubscribeResultDto {
  status: "unsubscribed" | "open";
  method: "one-click" | "email" | "link";
  url?: string;
}

/** AI-drafted reply options for a message (may be empty if AI is unavailable). */
export interface SmartReplyDto {
  suggestions: string[];
}

/** AI catch-up summary of a thread as short bullets (empty if unavailable). */
export interface ThreadSummaryDto {
  bullets: string[];
}

export type MailView = "inbox" | "drafts" | "sent" | "marked" | "spam" | "trash" | "all";
export type FolderCountsDto = Record<MailView, { total: number; unread: number }>;

// ─── Response envelopes (used by handlers via `satisfies`) ──────────────────

export interface ThreadListDto {
  threads: ThreadDto[];
  /** Keyset cursor for the next (older) page, or null when the list is exhausted. */
  nextCursor?: string | null;
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
export interface MailboxSettingsDto {
  id: string;
  type: MailboxType;
  displayName: string | null;
  signature: string | null;
  replyTo: string | null;
  spamFilter: SpamFilterLevel;
  spamAiTokenCap: number | null;
  spamUsage: { period: string; calls: number; tokens: number } | null;
  // Reader AI features (summary/category, smart reply, thread summarize).
  aiFeatures: boolean;
  aiTokenCap: number | null;
  aiUsage: { period: string; calls: number; tokens: number } | null;
  // Gateway PGP. The private key/passphrase are never sent; `pgpConfigured` says
  // whether a keypair exists, and the armored public key is shareable.
  pgpMode: PgpMode;
  pgpFingerprint: string | null;
  pgpPublicKey: string | null;
  pgpConfigured: boolean;
}

export interface ContactKeyDto {
  id: string;
  email: string;
  fingerprint: string;
  source: ContactKeySource;
  createdAt: string;
}
export interface ContactKeysDto {
  keys: ContactKeyDto[];
}
/** Returned once when a mailbox keypair is generated or imported. */
export interface PgpKeyResultDto {
  fingerprint: string;
  publicKey: string;
}
export interface MailboxMemberDto {
  userId: string;
  perms: number;
  email: string;
  name: string;
}
export interface MailboxMembersDto {
  members: MailboxMemberDto[];
}
export interface MailboxInviteDto {
  id: string;
  email: string;
  perms: number;
  createdAt: string;
}
export interface MailboxInvitesDto {
  invites: MailboxInviteDto[];
}
export interface DraftListDto {
  drafts: DraftDto[];
  /** Keyset cursor for the next (older) page, or null when the list is exhausted. */
  nextCursor?: string | null;
}
export interface DraftDetailDto {
  draft: DraftDto;
}
export interface LabelListDto {
  labels: LabelDto[];
}
export interface FolderListDto {
  folders: FolderDto[];
}
export interface RuleListDto {
  rules: RuleDto[];
}
/** Result of cloning a rule; `strippedLabels` names applyLabel targets that had
 * no counterpart in the destination mailbox and were dropped (cross-mailbox). */
export interface RuleCloneResultDto {
  id: string;
  strippedLabels: string[];
}
export interface MessageLabelsDto {
  labels: Record<string, MessageLabelDto[]>;
}
/** Distinct labels per thread id (aggregated across the thread's messages). */
export interface ThreadLabelsDto {
  labels: Record<string, MessageLabelDto[]>;
}
export interface SearchResultsDto {
  results: SearchResultDto[];
  hasMore: boolean;
}
export interface ContactsDto {
  contacts: ContactDto[];
}
export interface MeDto {
  user: MeUserDto | null;
}
