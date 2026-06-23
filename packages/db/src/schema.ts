import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  DOMAIN_KINDS,
  EDITOR_FORMATS,
  MAILBOX_TYPES,
  MESSAGE_DIRECTIONS,
  QUOTE_KINDS,
  SERVICE_MODES,
  SPAM_FILTER_LEVELS,
  SPAM_VERDICTS,
  USER_ROLES,
} from "./enums.ts";

const now = sql`(unixepoch())`;

// Timestamp column helpers. Drizzle column builders are stateful, so these are
// factory functions (fresh builder per call) rather than shared instances —
// the createdAt/updatedAt pattern repeats across nearly every table.
const createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(now);
const updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().default(now);
/** createdAt + updatedAt as a spreadable pair: `{ ...timestamps() }`. */
const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });

// ─── System config (lazy-init: auth secret, from-address, etc.) ─────────────

export const systemConfig = sqliteTable("system_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});

// ─── Better Auth (with admin + twoFactor plugin fields) ─────────────────────

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  // admin plugin
  role: text("role").notNull().default("user"),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
  // twoFactor plugin
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
  ...timestamps(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // admin plugin (impersonation)
    impersonatedBy: text("impersonated_by"),
    ...timestamps(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  ...timestamps(),
});

export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: integer("verified", { mode: "boolean" }).default(true),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

// ─── App-level user invites (admin-controlled signup) ───────────────────────

export const userInvite = sqliteTable(
  "user_invite",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("user"),
    token: text("token").notNull().unique(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("user_invite_email_uq").on(t.email),
    index("user_invite_expires_idx").on(t.expiresAt),
  ],
);

// ─── Domains & mailboxes ────────────────────────────────────────────────────

export const domain = sqliteTable(
  "domain",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    kind: text("kind", { enum: DOMAIN_KINDS }).notNull(),
    // Bitfield of MailboxKind (PERSONAL|GROUP|SERVICE|TEMP) — which mailbox
    // types may be hosted on this domain. 0 means none allowed.
    allowedKinds: integer("allowed_kinds").notNull().default(0),
    spfOk: integer("spf_ok", { mode: "boolean" }).notNull().default(false),
    dkimOk: integer("dkim_ok", { mode: "boolean" }).notNull().default(false),
    dmarcOk: integer("dmarc_ok", { mode: "boolean" }).notNull().default(false),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("domain_kind_idx").on(t.kind)],
);

// Per-user permission to create mailboxes of given kinds on a given domain.
// Admins bypass this check entirely.
export const domainGrant = sqliteTable(
  "domain_grant",
  {
    domainId: text("domain_id")
      .notNull()
      .references(() => domain.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    allowedKinds: integer("allowed_kinds").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.domainId, t.userId] }),
    index("domain_grant_user_idx").on(t.userId),
  ],
);

export const mailbox = sqliteTable(
  "mailbox",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domain.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    displayName: text("display_name"),
    type: text("type", { enum: MAILBOX_TYPES }).notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    signature: text("signature"),
    replyTo: text("reply_to"),
    // Spam filtering level: off | auth (SPF/DKIM/DMARC only) | standard (auth +
    // heuristics + DNSBL) | ai (standard + Workers AI on the gray zone).
    spamFilter: text("spam_filter", { enum: SPAM_FILTER_LEVELS }).notNull().default("standard"),
    // Monthly Workers AI token budget for spam classification; null = unlimited.
    // When exceeded, the ai level silently falls back to standard.
    spamAiTokenCap: integer("spam_ai_token_cap"),
    // service mailboxes only — SHA-256 (hex) of the bearer API key. Null until a
    // key is issued; rotating replaces it (single key, instant cutover).
    serviceKeyHash: text("service_key_hash"),
    // service mailboxes only — "duplex" accepts inbound (poll via API);
    // "send" rejects inbound with a hard bounce. Ignored for other types.
    serviceMode: text("service_mode", { enum: SERVICE_MODES }).notNull().default("duplex"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailbox_domain_local_uq").on(t.domainId, t.localPart),
    index("mailbox_owner_idx").on(t.ownerUserId),
    index("mailbox_expires_idx").on(t.expiresAt),
    index("mailbox_type_idx").on(t.type),
    uniqueIndex("mailbox_service_key_idx").on(t.serviceKeyHash),
  ],
);

// Inbound-only aliases. Mail addressed to (domainId, localPart) is delivered
// into `targetMailboxId`. There is no mailbox row for the alias address, so it
// cannot send. Created e.g. when an admin deletes a mailbox but wants to keep
// receiving mail sent to its old address.
export const redirect = sqliteTable(
  "redirect",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domain.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    targetMailboxId: text("target_mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("redirect_domain_local_uq").on(t.domainId, t.localPart),
    index("redirect_target_idx").on(t.targetMailboxId),
  ],
);

export const mailboxMember = sqliteTable(
  "mailbox_member",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    perms: integer("perms").notNull().default(0),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.mailboxId, t.userId] }),
    index("mailbox_member_user_idx").on(t.userId),
  ],
);

// ─── Threads, messages, attachments ─────────────────────────────────────────

export const thread = sqliteTable(
  "thread",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    subjectNorm: text("subject_norm").notNull().default(""),
    lastMsgAt: integer("last_msg_at", { mode: "timestamp" }).notNull().default(now),
    msgCount: integer("msg_count").notNull().default(0),
    participants: text("participants", { mode: "json" })
      .$type<{ name?: string; address: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    unreadCount: integer("unread_count").notNull().default(0),
    trashed: integer("trashed", { mode: "boolean" }).notNull().default(false),
    // When the thread entered the trash; null unless trashed. The cron purges
    // threads trashed longer than the retention window.
    trashedAt: integer("trashed_at", { mode: "timestamp" }),
    spam: integer("spam", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("thread_mailbox_last_idx").on(t.mailboxId, t.lastMsgAt),
    index("thread_mailbox_subject_idx").on(t.mailboxId, t.subjectNorm),
    index("thread_mailbox_state_idx").on(t.mailboxId, t.trashed, t.spam),
    index("thread_trashed_at_idx").on(t.trashedAt),
  ],
);

export const message = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: MESSAGE_DIRECTIONS }).notNull(),
    messageIdHdr: text("message_id_hdr"),
    inReplyTo: text("in_reply_to"),
    references: text("references", { mode: "json" }).$type<string[]>(),
    fromName: text("from_name"),
    fromAddr: text("from_addr").notNull(),
    // Envelope recipient the message actually arrived at — differs from the
    // mailbox address when delivered via a redirect/alias. Null for outbound.
    deliveredTo: text("delivered_to"),
    toAddrs: text("to_addrs", { mode: "json" })
      .$type<{ name?: string; address: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    ccAddrs: text("cc_addrs", { mode: "json" }).$type<{ name?: string; address: string }[]>(),
    bccAddrs: text("bcc_addrs", { mode: "json" }).$type<{ name?: string; address: string }[]>(),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    // Full plaintext body (HTML normalized to text), capped, for FTS body search.
    // Null on pre-migration rows; the raw message always lives in R2.
    bodyText: text("body_text"),
    // Recipient names+addresses concatenated, so search matches To/Cc too.
    toText: text("to_text"),
    flags: integer("flags").notNull().default(0),
    receivedAt: integer("received_at", { mode: "timestamp" }),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    rawR2Key: text("raw_r2_key"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    // Spam evaluation result (inbound only; null when filtering is off).
    spamVerdict: text("spam_verdict", { enum: SPAM_VERDICTS }),
    spamScore: integer("spam_score"),
    // Human-readable reasons that drive the warning banner.
    spamReasons: text("spam_reasons", { mode: "json" }).$type<string[]>(),
    // Summary of the parsed Authentication-Results header.
    spamAuth: text("spam_auth", { mode: "json" }).$type<{
      spf?: string;
      dkim?: string;
      dmarc?: string;
    }>(),
    // RFC 2369/8058 unsubscribe headers, captured at receive time. Their presence
    // is what flags a message as a newsletter in the UI. `listUnsubscribe` is the
    // raw List-Unsubscribe header (mailto:/https: targets); `listUnsubscribePost`
    // is the List-Unsubscribe-Post value ("List-Unsubscribe=One-Click") that marks
    // the sender as supporting one-click POST unsubscribe.
    listUnsubscribe: text("list_unsubscribe"),
    listUnsubscribePost: text("list_unsubscribe_post"),
    createdAt: createdAt(),
  },
  (t) => [
    index("message_mailbox_created_idx").on(t.mailboxId, t.createdAt),
    index("message_thread_idx").on(t.threadId),
    index("message_msgid_idx").on(t.messageIdHdr),
  ],
);

export const attachment = sqliteTable(
  "attachment",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    r2Key: text("r2_key").notNull(),
    inline: integer("inline", { mode: "boolean" }).notNull().default(false),
    contentId: text("content_id"),
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);

// Cumulative Workers AI spam-classification usage per mailbox. `period`
// (YYYY-MM) lets the monthly cap reset without deleting rows.
export const mailboxSpamUsage = sqliteTable("mailbox_spam_usage", {
  mailboxId: text("mailbox_id")
    .primaryKey()
    .references(() => mailbox.id, { onDelete: "cascade" }),
  period: text("period").notNull().default(""),
  calls: integer("calls").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  updatedAt: updatedAt(),
});

export const label = sqliteTable(
  "label",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#64748b"),
  },
  (t) => [uniqueIndex("label_mailbox_name_uq").on(t.mailboxId, t.name)],
);

export const messageLabel = sqliteTable(
  "message_label",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => label.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.labelId] })],
);

// ─── Custom folders ─────────────────────────────────────────────────────────

// User-level folders, not tied to any mailbox. A thread can be filed into one
// from any mailbox the user can read; the assignment lives in `thread_folder`.
export const folder = sqliteTable(
  "folder",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#64748b"),
    // Manual sidebar ordering; ties broken by createdAt.
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("folder_user_name_uq").on(t.userId, t.name),
    index("folder_user_idx").on(t.userId),
  ],
);

// Per-user filing of a thread into a custom folder. Folders are user-scoped but
// threads live in (possibly shared) mailboxes, so the assignment is keyed by
// user: one person's filing never affects another's views. A thread sits in at
// most one folder per user (true "move", single location) — hence the
// (userId, threadId) primary key. Filed threads are hidden from that user's
// active mailbox views (inbox/sent/marked).
export const threadFolder = sqliteTable(
  "thread_folder",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folder.id, { onDelete: "cascade" }),
    filedAt: integer("filed_at", { mode: "timestamp" }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.threadId] }),
    index("thread_folder_folder_idx").on(t.folderId),
    index("thread_folder_thread_idx").on(t.threadId),
  ],
);

export const mailboxInvite = sqliteTable(
  "mailbox_invite",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    perms: integer("perms").notNull().default(0),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailbox_invite_mailbox_email_uq").on(t.mailboxId, t.email),
    index("mailbox_invite_email_idx").on(t.email),
  ],
);

// Server-persisted compose drafts. A draft is not a message until sent; on
// send it flows through the normal outbound path and the draft row is deleted.
export const draft = sqliteTable(
  "draft",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Reply/forward threading context (the thread id is resolved at send time).
    inReplyTo: text("in_reply_to"),
    references: text("references", { mode: "json" }).$type<string[]>(),
    // Reply/forward quote source. The original message is re-quoted from its raw
    // `.eml` at send time (mail/quote.ts); persisting the ref lets a reopened
    // draft restore the quote it would otherwise lose.
    quoteMessageId: text("quote_message_id"),
    quoteKind: text("quote_kind", { enum: QUOTE_KINDS }),
    toAddrs: text("to_addrs", { mode: "json" })
      .$type<{ name?: string; address: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    ccAddrs: text("cc_addrs", { mode: "json" }).$type<{ name?: string; address: string }[]>(),
    bccAddrs: text("bcc_addrs", { mode: "json" }).$type<{ name?: string; address: string }[]>(),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    markdown: integer("markdown", { mode: "boolean" }).notNull().default(false),
    // Body editor format. `markdown` is kept in sync (= format === "markdown")
    // for back-compat; new code reads `format`.
    format: text("format", { enum: EDITOR_FORMATS }).notNull().default("text"),
    attachments: text("attachments", { mode: "json" })
      .$type<{ r2Key: string; filename: string; contentType: string; sizeBytes: number }[]>()
      .notNull()
      .default(sql`'[]'`),
    ...timestamps(),
  },
  (t) => [
    index("draft_mailbox_idx").on(t.mailboxId, t.updatedAt),
    index("draft_user_idx").on(t.userId),
  ],
);

// ─── Web Push notifications ─────────────────────────────────────────────────

// One row per browser/device that has granted notification permission and
// subscribed. Endpoint is the push service URL; p256dh/auth are the client
// keys used to encrypt the payload (RFC 8291).
export const pushSubscription = sqliteTable(
  "push_subscription",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscription_user_idx").on(t.userId)],
);

// Per-user opt-in to push notifications for a mailbox. Presence of a row means
// "notify me about new mail in this mailbox"; absence means off (the default).
export const mailboxNotify = sqliteTable(
  "mailbox_notify",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.mailboxId, t.userId] }),
    index("mailbox_notify_user_idx").on(t.userId),
  ],
);

export const shareToken = sqliteTable(
  "share_token",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    perms: integer("perms").notNull().default(1),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("share_token_mailbox_idx").on(t.mailboxId)],
);
