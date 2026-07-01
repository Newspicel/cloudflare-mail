// Single source of truth for column enums shared across layers. The value
// tuples live here; `schema.ts` feeds them to Drizzle's `text({ enum })`,
// `schemas.ts` (shared) feeds them to `z.enum`, and `responses.ts` derives its
// literal-union types from them — so DB, API input, and API output can never
// drift out of sync.

export const MAILBOX_TYPES = ["personal", "group", "service", "temp"] as const;
export type MailboxType = (typeof MAILBOX_TYPES)[number];

export const MESSAGE_DIRECTIONS = ["in", "out"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SPAM_FILTER_LEVELS = ["off", "auth", "standard", "ai"] as const;
export type SpamFilterLevel = (typeof SPAM_FILTER_LEVELS)[number];

export const SERVICE_MODES = ["duplex", "send"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export const SPAM_VERDICTS = ["clean", "suspicious", "spam"] as const;
export type SpamVerdict = (typeof SPAM_VERDICTS)[number];

// AI auto-category assigned to inbound mail (best-effort, Workers AI). A fixed
// taxonomy; each tag is defined for the model in `mail/ai.ts` (CATEGORY_GUIDE)
// and coloured as a chip in the list (thread-row.tsx). Keep the three in sync.
// `other` is the fallback when nothing fits.
export const AI_CATEGORIES = [
  "personal",
  "newsletter",
  "promotion",
  "shipping",
  "receipt",
  "finance",
  "travel",
  "social",
  "security",
  "update",
  "notification",
  "calendar",
  "other",
] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

// AI-judged importance of inbound mail (best-effort, Workers AI). Drives which
// kind of push notification a mailbox sends. "high" only for genuinely
// time-sensitive/personal mail; "low" for bulk/automated.
export const AI_PRIORITIES = ["high", "normal", "low"] as const;
export type AiPriority = (typeof AI_PRIORITIES)[number];

// Per-mailbox, per-priority-tier notification style. "none" = silent,
// "important" = attention-grabbing (sticky/vibrate).
export const NOTIFY_LEVELS = ["none", "normal", "important"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export const EDITOR_FORMATS = ["text", "markdown", "html"] as const;
export type EditorFormat = (typeof EDITOR_FORMATS)[number];

export const QUOTE_KINDS = ["reply", "forward"] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

// Per-mailbox PGP policy: off | sign outbound | sign + encrypt outbound.
export const PGP_MODES = ["off", "sign", "sign_encrypt"] as const;
export type PgpMode = (typeof PGP_MODES)[number];

// Inbound signature verification outcome stored on a message.
export const PGP_VERIFY = ["good", "bad", "unknown"] as const;
export type PgpVerify = (typeof PGP_VERIFY)[number];

// How a stored correspondent public key was obtained. `tofu` = captured from an
// inbound signed/attached key; `wkd` = auto-fetched from the sender's Web Key
// Directory; `import` = added by the owner.
export const CONTACT_KEY_SOURCES = ["import", "tofu", "wkd"] as const;
export type ContactKeySource = (typeof CONTACT_KEY_SOURCES)[number];

// A per-message PGP key event the reader surfaces as a banner: a contact key was
// auto-captured (TOFU/WKD) for the first time, or a known contact signed with a
// different key than the one on file (possible rotation — or impersonation).
export const PGP_KEY_EVENTS = ["captured", "rotated"] as const;
export type PgpKeyEvent = (typeof PGP_KEY_EVENTS)[number];

// A manual blocklist entry targets either a single address or a whole domain.
export const BLOCK_ENTRY_TYPES = ["email", "domain"] as const;
export type BlockEntryType = (typeof BLOCK_ENTRY_TYPES)[number];

// Lifecycle of a user-submitted block request awaiting admin review.
export const BLOCK_REQUEST_STATUS = ["pending", "approved", "denied"] as const;
export type BlockRequestStatus = (typeof BLOCK_REQUEST_STATUS)[number];

// ─── Reminders ──────────────────────────────────────────────────────────────

// A reminder is either set manually on a thread ("remind me about this") or
// created automatically when a mail is sent ("remind me if no reply").
export const REMINDER_KINDS = ["manual", "follow_up"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

// Lifecycle: pending until its time arrives → fired (surfaced in the bell) →
// done (user dismissed it). A follow-up flips to cancelled when a reply lands.
export const REMINDER_STATUSES = ["pending", "fired", "done", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

// ─── Inbound rules / filters ────────────────────────────────────────────────

// Message field a rule condition matches against. `deliveredTo` is the envelope
// recipient (the specific incoming address, incl. plus-aliases).
export const RULE_FIELDS = ["from", "to", "cc", "subject", "body", "deliveredTo"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

// How a condition value is compared. `wildcard` supports `*`/`?` globs; `regex`
// is opt-in power-user matching (compiled with safety caps, see mail/rules.ts).
export const RULE_OPS = [
  "contains",
  "equals",
  "startsWith",
  "endsWith",
  "wildcard",
  "regex",
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

// Combinator across a rule's conditions: all = AND, any = OR.
export const RULE_CONDITION_MODES = ["all", "any"] as const;
export type RuleConditionMode = (typeof RULE_CONDITION_MODES)[number];

// What a matched rule does. `stopProcessing` halts evaluation of lower-priority
// rules; `hardBlock` SMTP-rejects the message (nothing stored). `forward` and
// `autoReply` are best-effort outbound sends fired after the message is stored —
// they never block delivery (see mail/rule-sends.ts).
export const RULE_ACTION_TYPES = [
  "applyLabel",
  "moveFolder",
  "markRead",
  "markSpam",
  "forward",
  "autoReply",
  "hardBlock",
  "stopProcessing",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];
