// MCP's view of the mail model — a transport-owned adapter in the same spirit as
// imap/store.ts. It reads the model straight from D1 and leans on the shared
// modules (search-query, send, quote, hub) for anything cross-cutting, so the
// tool surface never restates a rule that lives elsewhere. Everything here
// throws AppError; translating to MCP is api/mcp.ts's job (invariant 9).

import type { DB } from "@cfmail/db";
import { attachment, label, mailbox, message, messageLabel, thread } from "@cfmail/db/schema";
import { Flag, hasFlag, setFlag } from "@cfmail/shared/flags";
import { has, Perm } from "@cfmail/shared/permissions";
import type { AddressObject, SearchFilters } from "@cfmail/shared/schemas";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { AppError } from "../errors.ts";
import { broadcastToUsers } from "../hub.ts";
import { buildQuote } from "../mail/quote.ts";
import { buildSearchQuery, type SearchRow } from "../mail/search-query.ts";
import { sendFromMailbox } from "../mail/send.ts";
import { recomputeThreadUnread } from "../mail/threads.ts";
import { enforceRateLimit } from "../rate-limit.ts";

// One MCP connection is one app password, so one mailbox — the same scope an
// IMAP client gets from the same credential.
export interface McpSession {
  appPasswordId: string;
  userId: string;
  mailboxId: string;
  address: string;
  perms: number;
}

// Bodies are the bulk of any tool result, so cap them: a model gets far more
// use out of twenty readable messages than one verbatim newsletter.
const BODY_CHARS = 4_000;
const MAX_THREAD_MESSAGES = 50;

export type ThreadView = "inbox" | "spam" | "trash" | "all";

export interface SearchArgs {
  query: string;
  searchIn: SearchFilters["searchIn"];
  from?: string;
  to?: string;
  subject?: string;
  exclude?: string;
  after?: string;
  before?: string;
  direction?: "in" | "out";
  hasAttachment?: boolean;
  folder: SearchFilters["folder"];
  sort: SearchFilters["sort"];
  limit: number;
  page: number;
}

export async function searchMail(env: Env, _db: DB, s: McpSession, a: SearchArgs) {
  const filters: SearchFilters = {
    q: a.query,
    searchIn: a.searchIn,
    from: a.from,
    to: a.to,
    subject: a.subject,
    exclude: a.exclude,
    after: a.after,
    before: a.before,
    direction: a.direction,
    hasAttachment: a.hasAttachment,
    folder: a.folder,
    sort: a.sort,
    mailboxId: s.mailboxId,
    limit: a.limit,
    page: a.page,
  };
  const { sql: stmt, binds } = buildSearchQuery(filters, [s.mailboxId]);
  const res = await env.DB.prepare(stmt)
    .bind(...binds)
    .all<SearchRow>();
  const rows = res.results ?? [];
  const hasMore = rows.length > a.limit;

  return {
    mailbox: s.address,
    hasMore,
    results: (hasMore ? rows.slice(0, a.limit) : rows).map((r) => ({
      messageId: r.messageId,
      threadId: r.threadId,
      subject: r.subject,
      snippet: r.snippet,
      from: formatAddress(r.fromName, r.fromAddr),
      direction: r.direction,
      unread: !hasFlag(r.flags, Flag.SEEN),
      starred: hasFlag(r.flags, Flag.STARRED),
      hasAttachments: r.hasAttachments === 1,
      date: epochToIso(r.receivedAt ?? r.sentAt),
    })),
  };
}

export async function listThreads(
  _env: Env,
  db: DB,
  s: McpSession,
  a: { view: ThreadView; limit: number; page: number },
) {
  const rows = await db
    .select()
    .from(thread)
    .where(and(eq(thread.mailboxId, s.mailboxId), viewFilter(a.view)))
    .orderBy(desc(thread.lastMsgAt))
    .limit(a.limit + 1)
    .offset(a.page * a.limit);

  const hasMore = rows.length > a.limit;
  const page = hasMore ? rows.slice(0, a.limit) : rows;
  const labelsByThread = await labelsFor(
    db,
    page.map((t) => t.id),
  );

  return {
    mailbox: s.address,
    view: a.view,
    hasMore,
    threads: page.map((t) => ({
      threadId: t.id,
      subject: t.subjectNorm,
      participants: t.participants.map((p) => formatAddress(p.name ?? null, p.address)),
      messageCount: t.msgCount,
      unreadCount: t.unreadCount,
      lastMessageAt: t.lastMsgAt.toISOString(),
      trashed: t.trashed,
      spam: t.spam,
      aiSummary: t.aiSummary,
      aiCategory: t.aiCategory,
      labels: labelsByThread.get(t.id) ?? [],
    })),
  };
}

export async function readThread(_env: Env, db: DB, s: McpSession, a: { threadId: string }) {
  const th = await requireThread(db, s, a.threadId);

  const msgs = await db
    .select()
    .from(message)
    .where(and(eq(message.threadId, th.id), eq(message.mailboxId, s.mailboxId)))
    .orderBy(asc(message.createdAt))
    .limit(MAX_THREAD_MESSAGES);

  const ids = msgs.map((m) => m.id);
  const atts = ids.length
    ? await db.select().from(attachment).where(inArray(attachment.messageId, ids))
    : [];
  const attsByMessage = new Map<string, typeof atts>();
  for (const at of atts) {
    const list = attsByMessage.get(at.messageId) ?? [];
    list.push(at);
    attsByMessage.set(at.messageId, list);
  }
  const labelsByThread = await labelsFor(db, [th.id]);

  return {
    mailbox: s.address,
    threadId: th.id,
    subject: th.subjectNorm,
    messageCount: th.msgCount,
    unreadCount: th.unreadCount,
    trashed: th.trashed,
    spam: th.spam,
    labels: labelsByThread.get(th.id) ?? [],
    truncated: th.msgCount > msgs.length,
    messages: msgs.map((m) => ({
      messageId: m.id,
      direction: m.direction,
      from: formatAddress(m.fromName, m.fromAddr),
      to: m.toAddrs.map((x) => formatAddress(x.name ?? null, x.address)),
      cc: (m.ccAddrs ?? []).map((x) => formatAddress(x.name ?? null, x.address)),
      subject: m.subject,
      date: (m.receivedAt ?? m.sentAt)?.toISOString() ?? null,
      unread: !hasFlag(m.flags, Flag.SEEN),
      starred: hasFlag(m.flags, Flag.STARRED),
      pgpSigned: m.pgpSigned,
      pgpEncrypted: m.pgpEncrypted,
      attachments: (attsByMessage.get(m.id) ?? [])
        .filter((at) => !at.inline)
        .map((at) => ({
          filename: at.filename,
          contentType: at.contentType,
          sizeBytes: at.sizeBytes,
        })),
      ...truncate(m.bodyText ?? m.snippet),
    })),
  };
}

export async function getMailbox(_env: Env, db: DB, s: McpSession) {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, s.mailboxId),
    columns: { displayName: true, type: true },
  });
  const [counts] = await db
    .select({
      threads: sql<number>`count(*)`,
      unread: sql<number>`coalesce(sum(case when ${thread.unreadCount} > 0 then 1 else 0 end), 0)`,
    })
    .from(thread)
    .where(and(eq(thread.mailboxId, s.mailboxId), viewFilter("inbox")));

  return {
    address: s.address,
    displayName: mb?.displayName ?? null,
    type: mb?.type ?? null,
    // What this connection may do — a tool call needing more is refused.
    canWrite: has(s.perms, Perm.WRITE),
    inboxThreads: counts?.threads ?? 0,
    inboxUnreadThreads: counts?.unread ?? 0,
  };
}

export async function listLabels(_env: Env, db: DB, s: McpSession) {
  const rows = await db
    .select({ id: label.id, name: label.name, color: label.color })
    .from(label)
    .where(eq(label.mailboxId, s.mailboxId))
    .orderBy(asc(label.name));
  return { mailbox: s.address, labels: rows };
}

export interface SendArgs {
  to: AddressObject[];
  cc?: AddressObject[];
  bcc?: AddressObject[];
  subject: string;
  text: string;
}

export async function sendMail(env: Env, db: DB, s: McpSession, a: SendArgs) {
  // Same budget the web app spends — an agent sending on the user's behalf
  // draws from one pool, not a second one.
  await enforceRateLimit(db, "send", s.userId, 60, 60 * 60 * 1000);
  const out = await sendFromMailbox(env, db, s.userId, {
    mailboxId: s.mailboxId,
    to: a.to,
    cc: a.cc,
    bcc: a.bcc,
    subject: a.subject,
    text: a.text,
  });
  return { messageId: out.messageId, threadId: out.threadId, pgpWarning: out.pgpWarning };
}

export async function replyToThread(
  env: Env,
  db: DB,
  s: McpSession,
  a: { threadId: string; text: string; replyAll: boolean; quoteOriginal: boolean },
) {
  const th = await requireThread(db, s, a.threadId);
  await enforceRateLimit(db, "send", s.userId, 60, 60 * 60 * 1000);

  // Reply to the newest message in the thread — the one a person would have
  // open when they hit Reply.
  const target = await db.query.message.findFirst({
    where: and(eq(message.threadId, th.id), eq(message.mailboxId, s.mailboxId)),
    orderBy: desc(message.createdAt),
  });
  if (!target) throw new AppError("not_found", "thread has no messages to reply to");

  const recipients = replyRecipients(target, s.address, a.replyAll);
  if (recipients.to.length === 0) {
    throw new AppError("unprocessable", "no reply recipient could be resolved");
  }

  const quote = a.quoteOriginal
    ? await buildQuote(env, db, s.userId, { messageId: target.id, kind: "reply" })
    : undefined;

  const chain = [...(target.references ?? []), target.messageIdHdr].filter((x): x is string => !!x);
  const out = await sendFromMailbox(
    env,
    db,
    s.userId,
    {
      mailboxId: s.mailboxId,
      to: recipients.to,
      cc: recipients.cc.length ? recipients.cc : undefined,
      subject: replySubject(target.subject),
      text: a.text,
      inReplyTo: target.messageIdHdr ?? undefined,
      references: chain.length ? chain : undefined,
    },
    quote,
  );
  return { messageId: out.messageId, threadId: out.threadId, pgpWarning: out.pgpWarning };
}

export async function updateThread(
  env: Env,
  db: DB,
  s: McpSession,
  a: { threadId: string; read?: boolean; trashed?: boolean; spam?: boolean },
) {
  const th = await requireThread(db, s, a.threadId);

  // Trash and spam are mutually exclusive buckets: entering one clears the
  // other so a thread only ever shows up in a single folder (mirrors
  // PATCH /api/threads/:id).
  const patch: Partial<{ trashed: boolean; trashedAt: Date | null; spam: boolean }> = {};
  if (a.trashed !== undefined) {
    patch.trashed = a.trashed;
    patch.trashedAt = a.trashed ? new Date() : null;
    if (a.trashed && a.spam === undefined) patch.spam = false;
  }
  if (a.spam !== undefined) {
    patch.spam = a.spam;
    if (a.spam && a.trashed === undefined) patch.trashed = false;
  }
  if (Object.keys(patch).length > 0) {
    await db.update(thread).set(patch).where(eq(thread.id, th.id));
  }

  let unreadCount = th.unreadCount;
  if (a.read !== undefined) {
    const seenBit = sql`${message.flags} | ${Flag.SEEN}`;
    const clearBit = sql`${message.flags} & ${~Flag.SEEN}`;
    await db
      .update(message)
      .set({ flags: a.read ? seenBit : clearBit })
      .where(and(eq(message.threadId, th.id), eq(message.direction, "in")));
    unreadCount = await recomputeThreadUnread(db, th.id);
    await broadcastToUsers(env, [s.userId], {
      type: "thread_read",
      mailboxId: s.mailboxId,
      threadId: th.id,
      read: a.read,
    });
  }

  // Everything else the hub can't infer from thread_read: peers refetch.
  if (Object.keys(patch).length > 0) {
    await broadcastToUsers(env, [s.userId], {
      type: "thread_updated",
      mailboxId: s.mailboxId,
      threadId: th.id,
    });
  }

  return {
    threadId: th.id,
    read: a.read,
    trashed: patch.trashed ?? th.trashed,
    spam: patch.spam ?? th.spam,
    unreadCount,
  };
}

export async function starMessage(
  env: Env,
  db: DB,
  s: McpSession,
  a: { messageId: string; starred: boolean },
) {
  const msg = await db.query.message.findFirst({
    where: and(eq(message.id, a.messageId), eq(message.mailboxId, s.mailboxId)),
    columns: { id: true, flags: true, threadId: true },
  });
  if (!msg) throw new AppError("not_found", "message not found");

  await db
    .update(message)
    .set({ flags: setFlag(msg.flags, Flag.STARRED, a.starred) })
    .where(eq(message.id, msg.id));
  await broadcastToUsers(env, [s.userId], {
    type: "thread_updated",
    mailboxId: s.mailboxId,
    threadId: msg.threadId,
  });

  return { messageId: msg.id, starred: a.starred };
}

export async function setThreadLabel(
  env: Env,
  db: DB,
  s: McpSession,
  a: { threadId: string; labelName: string; attached: boolean },
) {
  const th = await requireThread(db, s, a.threadId);
  const lb = await db.query.label.findFirst({
    where: and(eq(label.mailboxId, s.mailboxId), eq(label.name, a.labelName)),
    columns: { id: true, name: true },
  });
  if (!lb) throw new AppError("not_found", `no label named "${a.labelName}" in this mailbox`);

  const ids = (
    await db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.threadId, th.id), eq(message.mailboxId, s.mailboxId)))
  ).map((m) => m.id);

  if (ids.length > 0) {
    if (a.attached) {
      await db
        .insert(messageLabel)
        .values(ids.map((messageId) => ({ messageId, labelId: lb.id })))
        .onConflictDoNothing();
    } else {
      await db
        .delete(messageLabel)
        .where(and(eq(messageLabel.labelId, lb.id), inArray(messageLabel.messageId, ids)));
    }
    await broadcastToUsers(env, [s.userId], {
      type: "thread_updated",
      mailboxId: s.mailboxId,
      threadId: th.id,
    });
  }

  return { threadId: th.id, label: lb.name, attached: a.attached };
}

// ─── helpers ────────────────────────────────────────────────────────────────

// A thread is only addressable inside the connection's own mailbox, so scoping
// the lookup by mailboxId *is* the access check — there is no cross-mailbox id
// to leak and no second mailbox to escalate into.
async function requireThread(db: DB, s: McpSession, threadId: string) {
  const th = await db.query.thread.findFirst({
    where: and(eq(thread.id, threadId), eq(thread.mailboxId, s.mailboxId)),
  });
  if (!th) throw new AppError("not_found", "thread not found");
  return th;
}

function viewFilter(view: ThreadView) {
  switch (view) {
    case "spam":
      return eq(thread.spam, true);
    case "trash":
      return eq(thread.trashed, true);
    case "all":
      return undefined;
    default:
      return and(eq(thread.trashed, false), eq(thread.spam, false));
  }
}

async function labelsFor(db: DB, threadIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (threadIds.length === 0) return out;
  const rows = await db
    .select({ threadId: message.threadId, name: label.name })
    .from(messageLabel)
    .innerJoin(message, eq(message.id, messageLabel.messageId))
    .innerJoin(label, eq(label.id, messageLabel.labelId))
    .where(inArray(message.threadId, threadIds));
  for (const r of rows) {
    const list = out.get(r.threadId) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    out.set(r.threadId, list);
  }
  return out;
}

// Who a reply goes to. A reply to inbound mail goes back to its sender; a reply
// to our own outbound message goes to whoever it was addressed to. Reply-all
// adds the rest of the room, never our own address.
interface ReplyTarget {
  direction: "in" | "out";
  fromName: string | null;
  fromAddr: string;
  toAddrs: AddressObject[];
  ccAddrs: AddressObject[] | null;
}

function replyRecipients(
  target: ReplyTarget,
  self: string,
  replyAll: boolean,
): { to: AddressObject[]; cc: AddressObject[] } {
  const to =
    target.direction === "in"
      ? [{ name: target.fromName ?? undefined, address: target.fromAddr }]
      : target.toAddrs;
  const primary = dedupe(to, self, []);
  if (!replyAll) return { to: primary, cc: [] };

  const others = [...(target.direction === "in" ? target.toAddrs : []), ...(target.ccAddrs ?? [])];
  return {
    to: primary,
    cc: dedupe(
      others,
      self,
      primary.map((x) => x.address),
    ),
  };
}

function dedupe(list: AddressObject[], self: string, taken: string[]): AddressObject[] {
  const seen = new Set([self.toLowerCase(), ...taken.map((t) => t.toLowerCase())]);
  const out: AddressObject[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name, address: a.address });
  }
  return out;
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function truncate(body: string): { body: string; bodyTruncated?: true } {
  if (body.length <= BODY_CHARS) return { body };
  return { body: body.slice(0, BODY_CHARS), bodyTruncated: true };
}

function formatAddress(name: string | null, address: string): string {
  return name ? `${name} <${address}>` : address;
}

function epochToIso(seconds: number | null): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}
