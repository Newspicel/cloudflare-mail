// The MCP tool surface. Each entry owns its input schema (which also emits the
// JSON Schema in `tools/list`) and the permission bit it needs; api/mcp.ts
// enforces that bit before the handler runs, so RBAC stays one choke point
// (invariant 2).

import type { DB } from "@cfmail/db";
import { Perm, type PermBit } from "@cfmail/shared/permissions";
import { addressObject } from "@cfmail/shared/schemas";
import { z } from "zod";
import type { Env } from "../env.ts";
import {
  getMailbox,
  listLabels,
  listThreads,
  type McpSession,
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
  run(env: Env, db: DB, session: McpSession, args: never): Promise<unknown>;
}

// Each tool is written against its own parsed argument type; the registry stores
// them erased, and the dispatcher hands back exactly what the schema produced.
function define<S extends z.ZodType>(t: {
  name: string;
  title: string;
  description: string;
  schema: S;
  perm: PermBit;
  readOnly: boolean;
  run(env: Env, db: DB, session: McpSession, args: z.output<S>): Promise<unknown>;
}): McpTool {
  return t as unknown as McpTool;
}

const empty = z.object({});

const paging = {
  limit: z.number().int().min(1).max(100).default(25).describe("How many results to return."),
  page: z.number().int().min(0).max(1000).default(0).describe("Zero-based page of results."),
};

const searchArgs = z.object({
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
    .describe("'in' for received mail, 'out' for mail sent from this mailbox."),
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
  define({
    name: "get_mailbox",
    title: "Get mailbox",
    description:
      "Describe the mailbox this connection is attached to: its address, display name, whether you may write to it, and how many inbox threads are unread. Call this first to learn which address you are acting as.",
    schema: empty,
    perm: Perm.READ,
    readOnly: true,
    run: (env, db, s) => getMailbox(env, db, s),
  }),

  define({
    name: "list_threads",
    title: "List threads",
    description:
      "List conversation threads in this mailbox, most recently active first. Use this to browse a folder; use search_mail to find something specific.",
    schema: z.object({
      view: z
        .enum(["inbox", "spam", "trash", "all"])
        .default("inbox")
        .describe("Which threads to list. 'inbox' excludes Spam and Trash."),
      ...paging,
    }),
    perm: Perm.READ,
    readOnly: true,
    run: (env, db, s, a) => listThreads(env, db, s, a),
  }),

  define({
    name: "read_thread",
    title: "Read thread",
    description:
      "Read a whole conversation: each message's sender, recipients, date, attachment list and body. Bodies are plain text; long ones are truncated and flagged with bodyTruncated.",
    schema: z.object({
      threadId: z.string().min(1).describe("Thread id from list_threads or search_mail."),
    }),
    perm: Perm.READ,
    readOnly: true,
    run: (env, db, s, a) => readThread(env, db, s, a),
  }),

  define({
    name: "search_mail",
    title: "Search mail",
    description:
      "Full-text and metadata search across this mailbox. Returns matching messages with the thread id to open them in read_thread.",
    schema: searchArgs,
    perm: Perm.READ,
    readOnly: true,
    run: (env, db, s, a) => searchMail(env, db, s, a),
  }),

  define({
    name: "list_labels",
    title: "List labels",
    description:
      "List the labels defined in this mailbox. These names are what set_thread_label expects; labels cannot be created over MCP.",
    schema: empty,
    perm: Perm.READ,
    readOnly: true,
    run: (env, db, s) => listLabels(env, db, s),
  }),

  define({
    name: "send_mail",
    title: "Send mail",
    description:
      "Send a new plain-text message from this mailbox. This delivers real email immediately and cannot be recalled — confirm recipients and wording with the user before calling it.",
    schema: z.object({
      to: z.array(addressObject).min(1).max(100).describe("Primary recipients."),
      cc: z.array(addressObject).max(100).optional(),
      bcc: z.array(addressObject).max(100).optional(),
      subject: z.string().max(998).default(""),
      text: z.string().min(1).max(1_000_000).describe("Plain-text body."),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    run: (env, db, s, a) => sendMail(env, db, s, a),
  }),

  define({
    name: "reply_to_thread",
    title: "Reply to thread",
    description:
      "Reply to the newest message in a thread, keeping its subject and threading headers so the reply lands in the same conversation. Delivers real email immediately — confirm with the user first.",
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
    run: (env, db, s, a) => replyToThread(env, db, s, a),
  }),

  define({
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
    run: (env, db, s, a) => updateThread(env, db, s, a),
  }),

  define({
    name: "star_message",
    title: "Star message",
    description: "Star or unstar one message. Starred mail shows up in the Marked folder.",
    schema: z.object({
      messageId: z.string().min(1),
      starred: z.boolean(),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    run: (env, db, s, a) => starMessage(env, db, s, a),
  }),

  define({
    name: "set_thread_label",
    title: "Set thread label",
    description:
      "Attach or detach an existing label across every message in a thread. Use list_labels for the available names.",
    schema: z.object({
      threadId: z.string().min(1),
      labelName: z.string().min(1).describe("An existing label name, as list_labels reports it."),
      attached: z.boolean().describe("true attaches the label, false removes it."),
    }),
    perm: Perm.WRITE,
    readOnly: false,
    run: (env, db, s, a) => setThreadLabel(env, db, s, a),
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
