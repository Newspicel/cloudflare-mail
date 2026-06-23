// Single source of truth for column enums shared across layers. The value
// tuples live here; `schema.ts` feeds them to Drizzle's `text({ enum })`,
// `schemas.ts` (shared) feeds them to `z.enum`, and `responses.ts` derives its
// literal-union types from them — so DB, API input, and API output can never
// drift out of sync.

export const MAILBOX_TYPES = ["personal", "group", "service", "temp"] as const;
export type MailboxType = (typeof MAILBOX_TYPES)[number];

export const DOMAIN_KINDS = ["primary", "sub"] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

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

// How a stored correspondent public key was obtained.
export const CONTACT_KEY_SOURCES = ["import", "tofu"] as const;
export type ContactKeySource = (typeof CONTACT_KEY_SOURCES)[number];

// A manual blocklist entry targets either a single address or a whole domain.
export const BLOCK_ENTRY_TYPES = ["email", "domain"] as const;
export type BlockEntryType = (typeof BLOCK_ENTRY_TYPES)[number];

// Lifecycle of a user-submitted block request awaiting admin review.
export const BLOCK_REQUEST_STATUS = ["pending", "approved", "denied"] as const;
export type BlockRequestStatus = (typeof BLOCK_REQUEST_STATUS)[number];

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
// rules; `hardBlock` SMTP-rejects the message (nothing stored).
export const RULE_ACTION_TYPES = [
  "applyLabel",
  "moveFolder",
  "markRead",
  "markSpam",
  "hardBlock",
  "stopProcessing",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];
