// The MCP tool surface. Each entry owns its input schema (which also emits the
// JSON Schema in `tools/list`), the permission bit it needs, and the mailbox(es)
// it acts on. The dispatcher (api/mcp.ts → resolveTarget) turns that target
// into mailboxes the caller holds the bit on before the handler runs, so RBAC
// stays one choke point (invariant 2) and no tool sees a mailbox it can't use.

import type { DB } from "@cfmail/db";
import { Perm, type PermBit } from "@cfmail/shared/permissions";
import { addressObject } from "@cfmail/shared/schemas";
import { z } from "zod";
import type { Env } from "../env.ts";
import {
  listLabels,
  listMailboxes,
  listThreads,
  type McpMailbox,
  type McpTarget,
  readThread,
  replyToThread,
  searchMail,
  sendMail,
  setThreadLabel,
  starMessage,
  updateThread,
} from "./store.ts";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  perm: PermBit;
  // Advertised as an MCP tool annotation so a client can show read-only tools
  // without a confirmation prompt and gate the rest.
  readOnly: boolean;
  target(args: never): McpTarget;
  run(env: Env, db: DB, mailboxes: McpMailbox[], args: never): Promise<unknown>;
}

interface Spec<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  schema: S;
  perm: PermBit;
  readOnly: boolean;
}

// Each tool is written against its own parsed argument type; the registry stores
// them erased, and the dispatcher hands back exactly what the schema produced.
// `many` tools get every resolved mailbox; `one` tools exactly one.
function many<S extends z.ZodType>(
  t: Spec<S> & {
    target(args: z.output<S>): McpTarget;
    run(env: Env, db: DB, mailboxes: McpMailbox[], args: z.output<S>): Promise<unknown>;
  },
): McpTool {
  return t as unknown as McpTool;
}

function one<S extends z.ZodType>(
  t: Spec<S> & {
    target(args: z.output<S>): Exclude<McpTarget, { kind: "mailboxes" }>;
    run(env: Env, db: DB, mailbox: McpMailbox, args: z.output<S>): Promise<unknown>;
  },
): McpTool {
  return {
    ...t,
    run: (env: Env, db: DB, mailboxes: McpMailbox[], args: z.output<S>) => {
      const [mb] = mailboxes;
      if (!mb) throw new Error("dispatcher resolved no mailbox for a single-mailbox tool");
      return t.run(env, db, mb, args);
    },
  } as unknown as McpTool;
}

const mailboxArg = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .describe("Address of the mailbox, as list_mailboxes reports it.");

const paging = {
  limit: z.number().int().min(1).max(100).default(25).describe("How many results to return."),
  page: z.number().int().min(0).max(1000).default(0).describe("Zero-based page of results."),
};

const searchArgs = z.object({
  mailbox: mailboxArg.optional().describe("Only search this mailbox. Omit to search all of them."),
  query: z
    .string()
    .trim()
    .max(500)
    .default("")
    .describe(
      "Words to look for. Prefix a word with '-' to exclude it. Leave empty to filter on metadata alone.",
    ),
  searchIn: z
    .enum(["all", "subject", "from", "body"])
    .default("all")
    .describe("Restrict the free-text match to one part of the message."),
  from: z.string().trim().max(200).optional().describe("Match the sender name or address."),
  to: z.string().trim().max(200).optional().describe("Match a recipient name or address."),
  subject: z.string().trim().max(200).optional().describe("Match words in the subject."),
  exclude: z.string().trim().max(200).optional().describe("Words that must not appear."),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only mail on or after this date (YYYY-MM-DD)."),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only mail on or before this date (YYYY-MM-DD)."),
  direction: z
    .enum(["in", "out"])
    .optional()
    .describe("'in' for received mail, 'out' for mail you sent."),
  hasAttachment: z.boolean().optional().describe("Only mail carrying an attachment."),
  folder: z
    .enum(["any", "inbox", "sent", "marked", "spam", "trash"])
    .default("any")
    .describe("Which folder to search. 'any' covers everything except Spam and Trash."),
  sort: z
    .enum(["newest", "oldest", "relevance"])
    .default("newest")
    .describe("Result order. 'relevance' only applies when query is set."),
  ...paging,
});

export const TOOLS: McpTool[] = [
  many({
    name: "list_mailboxes",
    title: "List mailboxes",
    description:
      "List every mailbox this account can reach: its address, display name, whether you may write to it, and how many inbox threads are unread. Call this first — other tools take these addresses.",
    schema: z.object({}),
    perm: Perm.READ,
    readOnly: true,
    target: () => ({ kind: "mailboxes" }),
    run: (_env, db, mbs) => listMailboxes(db, mbs),
  }),

  many({
    name: "list_threads",
    title: "List threads",
    description:
      "List conversation threads, most recently active first, across every mailbox or just one. Use this to browse a folder; use search_mail to find something specific.",
    schema: z.object({
      mailbox: mailboxArg.optional().describe("Only list this mailbox. Omit for all of them."),
      view: z
        .enum(["inbox", "spam", "trash", "all"])
        .default("inbox")
        .describe("Which threads to list. 'inbox' excludes Spam and Trash."),
      ...paging,
    }),
    perm: Perm.READ,
    readOnly: true,
    target: (a) => ({ kind: "mailboxes", address: a.mailbox }),
    run: (env, db, mbs, a) => listThreads(env, db, mbs, a),
  }),

  one({
    name: "read_thread",
    title: "Read thread",
    description:
      "Read a whole conversation: each message's sender, recipients, date, attachment list and body. Bodies are plain text; long ones are truncated and flagged with bodyTruncated.",
    schema: z.object({
      threadId: z.string().min(1).describe("Thread id from list_threads or search_mail."),
    }),
    perm: Perm.READ,
    readOnly: true,
    target: (a) => ({ kind: "thread", id: a.threadId }),
    run: (env, db, mb, a) => readThread(env, db, mb, a),
  }),

  many({
    name: "search_mail",
    title: "Search mail",
    description:
      "Full-text and metadata search across every mailbox, or one. Returns matching messages with their mailbox and the thread id to open them in read_thread.",
    schema: searchArgs,
    perm: Perm.READ,
    readOnly: true,
    target: (a) => ({ kind: "mailboxes", address: a.mailbox }),
    run: (env, db, mbs, a) => searchMail(env, db, mbs, a),
  }),

  one({
    name: "list_labels",
    title: "List labels",
    description:
      "List the labels defined in one mailbox. These names are what set_thread_label expects; labels cannot be created over MCP.",
    schema: z.object({ mailbox: mailboxArg }),
    perm: Perm.READ,
    readOnly: true,
    target: (a) => ({ kind: "mailbox", address: a.mailbox }),
    run: (env, db, mb) => listLabels(env, db, mb),
  }),

  one({
    name: "send_mail",
    title: "Send mail",
    description:
      "Send a new plain-text message from one of your mailboxes. This delivers real email immediately and cannot be recalled — confirm the sending address, recipients and wording with the user before calling it.",
    schema: z.object({
      mailbox: mailboxArg.describe("The mailbox to send from, as list_mailboxes reports it."),
      to: z.array(addressObject).min(1).max(100).describe("Primary recipients."),
      cc: z.array(addressObject).max(100).optional(),
      bcc: z.array(addressObject).max(100).optional(),
      subject: z.string().max(998).default(""),
      text: z.string().min(1).max(1_000_000).describe("Plain-text body."),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    target: (a) => ({ kind: "mailbox", address: a.mailbox }),
    run: (env, db, mb, a) => sendMail(env, db, mb, a),
  }),

  one({
    name: "reply_to_thread",
    title: "Reply to thread",
    description:
      "Reply to the newest message in a thread from the mailbox the thread belongs to, keeping its subject and threading headers so the reply lands in the same conversation. Delivers real email immediately — confirm with the user first.",
    schema: z.object({
      threadId: z.string().min(1),
      text: z.string().min(1).max(1_000_000).describe("Plain-text body of the reply."),
      replyAll: z
        .boolean()
        .default(false)
        .describe("Also copy the other recipients of the message being replied to."),
      quoteOriginal: z
        .boolean()
        .default(true)
        .describe("Append the quoted original below the reply."),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    target: (a) => ({ kind: "thread", id: a.threadId }),
    run: (env, db, mb, a) => replyToThread(env, db, mb, a),
  }),

  one({
    name: "update_thread",
    title: "Update thread",
    description:
      "Mark a thread read or unread, move it to or out of Trash, or flag it as spam. Trash and Spam are mutually exclusive: entering one leaves the other.",
    schema: z
      .object({
        threadId: z.string().min(1),
        read: z.boolean().optional().describe("Mark every inbound message read or unread."),
        trashed: z.boolean().optional().describe("Move to Trash, or restore out of it."),
        spam: z.boolean().optional().describe("Flag as spam, or clear the flag."),
      })
      .refine(
        (a) => a.read !== undefined || a.trashed !== undefined || a.spam !== undefined,
        "set at least one of read, trashed or spam",
      ),
    perm: Perm.WRITE,
    readOnly: false,
    target: (a) => ({ kind: "thread", id: a.threadId }),
    run: (env, db, mb, a) => updateThread(env, db, mb, a),
  }),

  one({
    name: "star_message",
    title: "Star message",
    description: "Star or unstar one message. Starred mail shows up in the Marked folder.",
    schema: z.object({
      messageId: z.string().min(1),
      starred: z.boolean(),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    target: (a) => ({ kind: "message", id: a.messageId }),
    run: (env, db, mb, a) => starMessage(env, db, mb, a),
  }),

  one({
    name: "set_thread_label",
    title: "Set thread label",
    description:
      "Attach or detach an existing label across every message in a thread. Labels belong to a mailbox: use list_labels on the thread's mailbox for the available names.",
    schema: z.object({
      threadId: z.string().min(1),
      labelName: z.string().min(1).describe("An existing label name, as list_labels reports it."),
      attached: z.boolean().describe("true attaches the label, false removes it."),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    target: (a) => ({ kind: "thread", id: a.threadId }),
    run: (env, db, mb, a) => setThreadLabel(env, db, mb, a),
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// `tools/list` payload. JSON Schema is derived from the same zod schema the
// dispatcher validates with, so the two can't drift.
export function describeTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema, { io: "input" }),
    annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly },
  }));
}
