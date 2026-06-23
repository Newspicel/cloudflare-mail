import {
  BLOCK_ENTRY_TYPES,
  DOMAIN_KINDS,
  EDITOR_FORMATS,
  MAILBOX_TYPES,
  MESSAGE_DIRECTIONS,
  PGP_MODES,
  QUOTE_KINDS,
  SERVICE_MODES,
  SPAM_FILTER_LEVELS,
  USER_ROLES,
} from "@cfmail/db/enums";
import { z } from "zod";

// Enum validators derive from the shared tuples in @cfmail/db/enums, so the
// Zod input contracts can never drift from the DB columns.
export const MailboxType = z.enum(MAILBOX_TYPES);
export type MailboxType = z.infer<typeof MailboxType>;

export const DomainKind = z.enum(DOMAIN_KINDS);
export type DomainKind = z.infer<typeof DomainKind>;

export const MessageDirection = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof MessageDirection>;

// No "+" — it is reserved for plus/sub-addressing, which routes to the base
// mailbox (see mail/receive.ts). Allowing it in a real local part would shadow
// every "<base>+anything@" alias of an existing mailbox.
const localPart = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i, "invalid local part");

const domainName = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, "invalid domain");

const emailAddress = z.email().max(320);

export const addressObject = z.object({
  name: z.string().max(200).optional(),
  address: emailAddress,
});
export type AddressObject = z.infer<typeof addressObject>;

// RFC 5322 msg-id shape (<id-left@id-right>). The angle-bracket + no-whitespace
// form blocks CRLF/header injection: these flow verbatim into In-Reply-To /
// References on the real outbound (env.EMAIL.send) and into the archived .eml,
// where mimetext writes custom headers without sanitizing.
const messageId = z
  .string()
  .max(998)
  .regex(/^<[^\s<>]+@[^\s<>]+>$/, "invalid Message-ID");

// Attachment filename: mimetext interpolates this unescaped into the quoted
// Content-Disposition fil="…", so reject control chars, quotes and backslash.
const attachmentFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => ![...s].some((c) => c.charCodeAt(0) < 0x20 || c === '"' || c === "\\"),
    "invalid filename",
  );

const allowedKinds = z.number().int().min(0).max(15); // 4 bits

export const createDomain = z.object({
  name: domainName,
  kind: DomainKind,
  allowedKinds: allowedKinds.default(0),
});

export const updateDomain = z.object({
  allowedKinds: allowedKinds.optional(),
});

export const upsertDomainGrant = z.object({
  userId: z.string().min(1),
  allowedKinds,
});

export const createUserInvite = z.object({
  email: emailAddress,
  role: z.enum(USER_ROLES).default("user"),
});

export const adminCreateUser = z.object({
  email: emailAddress,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
  role: z.enum(USER_ROLES).default("user"),
});

export const adminUpdateUser = z.object({
  role: z.enum(USER_ROLES).optional(),
  banned: z.boolean().optional(),
});

export const acceptInvite = z.object({
  token: z.string().min(8),
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});

export const bootstrapAdmin = z.object({
  email: emailAddress,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});

export const setAuthFromAddress = z.object({
  address: emailAddress,
});

export const updateThread = z.object({
  trashed: z.boolean().optional(),
  spam: z.boolean().optional(),
  read: z.boolean().optional(),
});

const draftAttachment = z.object({
  r2Key: z.string().min(1),
  filename: attachmentFilename,
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().min(0),
});

// Reference to an original message to quote in a reply/forward. The server
// resolves the quoted body from the raw `.eml` at send time (mail/quote.ts).
export const messageQuoteRef = z.object({
  messageId: z.string().min(1),
  kind: z.enum(QUOTE_KINDS),
});

export const createDraft = z.object({
  mailboxId: z.string().min(1),
  fromAddress: emailAddress.optional(),
  to: z.array(addressObject).max(100).default([]),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).default(""),
  body: z.string().max(5_000_000).default(""),
  markdown: z.boolean().default(false),
  format: z.enum(EDITOR_FORMATS).default("text"),
  inReplyTo: messageId.optional(),
  references: z.array(messageId).max(100).optional(),
  quote: messageQuoteRef.nullish(),
  attachments: z.array(draftAttachment).max(20).default([]),
});
export type CreateDraftInput = z.infer<typeof createDraft>;

export const updateDraft = z.object({
  fromAddress: emailAddress.nullish(),
  to: z.array(addressObject).max(100).optional(),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(5_000_000).optional(),
  markdown: z.boolean().optional(),
  format: z.enum(EDITOR_FORMATS).optional(),
  inReplyTo: messageId.optional(),
  references: z.array(messageId).max(100).optional(),
  quote: messageQuoteRef.nullish(),
  attachments: z.array(draftAttachment).max(20).optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraft>;

const labelColor = z.string().regex(/^#[0-9a-f]{6}$/i, "expected hex color (#rrggbb)");

export const createLabel = z.object({
  mailboxId: z.string().min(1),
  name: z.string().min(1).max(64),
  color: labelColor.optional(),
});

export const updateLabel = z.object({
  name: z.string().min(1).max(64).optional(),
  color: labelColor.optional(),
});

// ─── Custom folders ─────────────────────────────────────────────────────────

export const createFolder = z.object({
  name: z.string().min(1).max(64),
  color: labelColor.optional(),
});

export const updateFolder = z.object({
  name: z.string().min(1).max(64).optional(),
  color: labelColor.optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

export const fileThreads = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(200),
});

export const inviteMember = z.object({
  mailboxId: z.string().min(1),
  email: emailAddress,
  read: z.boolean().default(true),
  write: z.boolean().default(false),
  manage: z.boolean().default(false),
});

export const createMailbox = z.object({
  domainId: z.string().min(1),
  localPart,
  displayName: z.string().max(200).optional(),
  type: MailboxType,
  signature: z.string().max(5000).optional(),
  replyTo: emailAddress.optional(),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 30)
    .optional(),
});

export const ServiceMode = z.enum(SERVICE_MODES);
export type ServiceMode = z.infer<typeof ServiceMode>;

// Admin: create a key-driven service mailbox. No owner/members — access is the
// API key alone. `duplex` accepts inbound (poll via API); `send` is send-only.
export const createServiceMailbox = z.object({
  domainId: z.string().min(1),
  localPart,
  displayName: z.string().max(200).optional(),
  mode: ServiceMode.default("duplex"),
});

// Admin: edit a service mailbox's identity / direction.
export const updateServiceMailbox = z.object({
  displayName: z.string().max(200).nullable().optional(),
  mode: ServiceMode.optional(),
});

// Admin: create a mailbox owned by an arbitrary user.
export const adminCreateMailbox = z.object({
  domainId: z.string().min(1),
  localPart,
  ownerUserId: z.string().min(1),
  type: MailboxType,
  displayName: z.string().max(200).optional(),
});

// Admin: hand a mailbox to a different owner and/or switch it between the
// personal and group types. At least one change must be supplied.
export const migrateMailbox = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    type: z.enum(["personal", "group"]).optional(),
  })
  .refine((v) => v.ownerUserId !== undefined || v.type !== undefined, {
    message: "nothing to change",
  });

// Admin: delete a mailbox, optionally leaving a redirect at its old address.
export const adminDeleteMailbox = z.object({
  redirectToMailboxId: z.string().min(1).optional(),
});

// Admin: standalone redirect creation. "*" is the domain catch-all, which
// receives any address with no matching mailbox or specific redirect.
const redirectLocalPart = z.union([localPart, z.literal("*")]);

export const createRedirect = z.object({
  domainId: z.string().min(1),
  localPart: redirectLocalPart,
  targetMailboxId: z.string().min(1),
});

// Admin: re-point an existing redirect at a different target mailbox.
export const updateRedirect = z.object({
  targetMailboxId: z.string().min(1),
});

// ─── Manual blocklist ───────────────────────────────────────────────────────

export const BlockEntryType = z.enum(BLOCK_ENTRY_TYPES);
export type BlockEntryType = z.infer<typeof BlockEntryType>;

// Admin: add a blocklist entry. The value must parse as an email (type=email)
// or a bare domain (type=domain); the server additionally refuses domain entries
// for protected providers (gmail, outlook, …).
export const createBlockEntry = z
  .object({
    type: BlockEntryType,
    value: z.string().trim().min(1).max(320),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      v.type === "email"
        ? emailAddress.safeParse(v.value).success
        : domainName.safeParse(v.value).success,
    { message: "value must be a valid email or domain", path: ["value"] },
  );
export type CreateBlockEntryInput = z.infer<typeof createBlockEntry>;

// A reader requesting a sender be blocked. The sender identity comes from the
// message (server-side); only an optional note is supplied.
export const createBlockRequest = z.object({
  note: z.string().max(500).optional(),
});

// Admin: replace the protected-domains whitelist.
export const setProtectedDomains = z.object({
  domains: z.array(domainName).max(500),
});

// Any reader: check which of a set of recipient addresses are blocked, to warn
// before composing/sending. Loose strings so partial/odd input never 400s.
export const checkBlockRecipients = z.object({
  addresses: z.array(z.string().max(320)).max(200),
});

export const spamFilterLevel = z.enum(SPAM_FILTER_LEVELS);
export type SpamFilterLevel = z.infer<typeof spamFilterLevel>;

export const pgpMode = z.enum(PGP_MODES);
export type PgpMode = z.infer<typeof pgpMode>;

export const updateMailboxSettings = z.object({
  displayName: z.string().max(200).nullable().optional(),
  signature: z.string().max(5000).nullable().optional(),
  replyTo: z
    .union([emailAddress, z.literal("")])
    .nullable()
    .optional(),
  spamFilter: spamFilterLevel.optional(),
  spamAiTokenCap: z.number().int().positive().max(100_000_000).nullable().optional(),
  pgpMode: pgpMode.optional(),
});

// Import an existing armored PGP private key for a mailbox. Bounded so a giant
// blob can't bloat a request.
export const importPgpKey = z.object({
  privateKey: z.string().min(1).max(200_000),
  passphrase: z.string().max(1000).optional(),
});
export type ImportPgpKeyInput = z.infer<typeof importPgpKey>;

// Add a correspondent public key. `email` is optional — if omitted the first
// address in the key's user IDs is used.
export const addContactKey = z.object({
  publicKey: z.string().min(1).max(200_000),
  email: emailAddress.optional(),
});
export type AddContactKeyInput = z.infer<typeof addContactKey>;
export type UpdateMailboxSettingsInput = z.infer<typeof updateMailboxSettings>;

export const grantMember = z.object({
  mailboxId: z.string().min(1),
  userId: z.string().min(1),
  read: z.boolean().default(false),
  write: z.boolean().default(false),
  manage: z.boolean().default(false),
});

export const sendMessage = z.object({
  mailboxId: z.string().min(1),
  // Optional sender override. Must be the mailbox's own address or a plus-alias
  // of it (same base local part + domain); enforced server-side in mail/send.ts.
  fromAddress: emailAddress.optional(),
  to: z.array(addressObject).min(1).max(100),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(1_000_000).optional(),
  html: z.string().max(5_000_000).optional(),
  inReplyTo: messageId.optional(),
  references: z.array(messageId).max(100).optional(),
  // Reply/forward: the original message to quote below the composed body. The
  // server fetches its raw `.eml` and appends a formatted quote at send time.
  quote: messageQuoteRef.optional(),
  attachments: z
    .array(
      z.object({
        r2Key: z.string().min(1),
        filename: attachmentFilename,
        contentType: z.string().min(1).max(127),
      }),
    )
    .max(20)
    .optional(),
});
export type SendMessageInput = z.infer<typeof sendMessage>;

// Key-authed send from a service mailbox — the mailbox is resolved from the
// bearer key; attachments (pre-uploaded R2 keys) and reply/forward quoting
// (resolved from a stored message the key holder can't reference) are omitted.
export const serviceSend = sendMessage.omit({
  mailboxId: true,
  attachments: true,
  quote: true,
});
export type ServiceSendInput = z.infer<typeof serviceSend>;

export const createTempMailbox = z.object({
  domainId: z.string().min(1),
  displayName: z.string().max(200).optional(),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 7)
    .default(3600),
});

// ─── Advanced search ────────────────────────────────────────────────────────

export const SearchIn = z.enum(["all", "subject", "from", "body"]);
export type SearchIn = z.infer<typeof SearchIn>;

// "any" excludes Trash + Spam (Gmail-like); the rest map to folder state.
export const SearchFolder = z.enum(["any", "inbox", "sent", "marked", "spam", "trash"]);
export type SearchFolder = z.infer<typeof SearchFolder>;

// Query params arrive as strings; coerce/normalize them here so the worker and
// the web client agree on the exact filter contract.
const boolParam = z.preprocess(
  (v) => (v === undefined || v === "" ? undefined : v === "true" || v === "1"),
  z.boolean().optional(),
);
const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .optional();
const textParam = z.string().trim().max(200).optional();

export const searchFilters = z.object({
  q: z.string().trim().max(500).optional().default(""),
  searchIn: SearchIn.optional().default("all"),
  from: textParam,
  to: textParam,
  subject: textParam,
  exclude: textParam,
  after: dateParam,
  before: dateParam,
  direction: MessageDirection.optional(),
  hasAttachment: boolParam,
  folder: SearchFolder.optional().default("any"),
  // Blank / "all" → every readable mailbox; a real id → just that one.
  mailboxId: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  page: z.coerce.number().int().min(0).max(1000).optional().default(0),
});
export type SearchFilters = z.infer<typeof searchFilters>;
