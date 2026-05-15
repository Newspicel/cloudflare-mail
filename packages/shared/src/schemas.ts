import { z } from "zod";

export const MailboxType = z.enum(["personal", "group", "service", "temp"]);
export type MailboxType = z.infer<typeof MailboxType>;

export const DomainKind = z.enum(["primary", "sub"]);
export type DomainKind = z.infer<typeof DomainKind>;

export const MessageDirection = z.enum(["in", "out"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

const localPart = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/i, "invalid local part");

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

export const createDomain = z.object({
  name: domainName,
  kind: DomainKind,
});

export const updateDomain = z.object({
  isTempDomain: z.boolean().optional(),
});

export const updateThread = z.object({
  archived: z.boolean().optional(),
  trashed: z.boolean().optional(),
});

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

export const updateMailboxSettings = z.object({
  displayName: z.string().max(200).nullable().optional(),
  signature: z.string().max(5000).nullable().optional(),
  replyTo: z
    .union([emailAddress, z.literal("")])
    .nullable()
    .optional(),
});
export type UpdateMailboxSettingsInput = z.infer<typeof updateMailboxSettings>;

export const grantMember = z
  .object({
    mailboxId: z.string().min(1),
    userId: z.string().min(1).optional(),
    email: emailAddress.optional(),
    read: z.boolean().default(false),
    write: z.boolean().default(false),
    manage: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.userId) !== Boolean(v.email), {
    message: "provide exactly one of userId or email",
  });

export const sendMessage = z.object({
  mailboxId: z.string().min(1),
  to: z.array(addressObject).min(1).max(100),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(1_000_000).optional(),
  html: z.string().max(5_000_000).optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        r2Key: z.string().min(1),
        filename: z.string().min(1).max(255),
        contentType: z.string().min(1).max(127),
      }),
    )
    .max(20)
    .optional(),
});
export type SendMessageInput = z.infer<typeof sendMessage>;

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

export const createShareToken = z.object({
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 30)
    .default(60 * 60 * 24 * 7),
});
