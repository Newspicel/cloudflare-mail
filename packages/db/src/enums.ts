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
