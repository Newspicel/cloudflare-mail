import type { DB } from "@cfmail/db";
import { message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { normalizeSubject } from "./mime.ts";

// Same prefixes normalizeSubject strips — used to tell a reply ("Re: X") from a
// bare first-contact message whose subject merely happens to collide.
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i;

const SUBJECT_WINDOW_SECONDS = 60 * 60 * 24 * 7;
// In-Reply-To/References are attacker-controlled, so a header match into an
// existing thread is only honored when the thread is still recent. Beyond this
// a leaked Message-ID can't be replayed to graft into a dormant conversation.
const HEADER_MATCH_WINDOW_SECONDS = 60 * 60 * 24 * 180;

export interface ResolveThreadInput {
  mailboxId: string;
  subject: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  participants: { name?: string; address: string }[];
  // Sender of the message, used to corroborate a header-based join.
  fromAddr: string;
  // Skip the anti-spoofing corroboration check. Set for our own outbound mail,
  // whose In-Reply-To/References we generate and therefore trust.
  trustHeaders?: boolean;
}

export interface ResolveThreadResult {
  threadId: string;
  // The message was spliced into a pre-existing thread on an In-Reply-To /
  // References header match. These are attacker-influenced, so callers must not
  // suppress spam filing for such joins.
  joinedByHeader: boolean;
}

export async function resolveThreadId(
  db: DB,
  input: ResolveThreadInput,
): Promise<ResolveThreadResult> {
  const headerIds = [
    ...(input.references ?? []),
    ...(input.inReplyTo ? [input.inReplyTo] : []),
  ].filter(Boolean);

  if (headerIds.length) {
    const headerHits = await db.query.message.findMany({
      where: and(eq(message.mailboxId, input.mailboxId), inArray(message.messageIdHdr, headerIds)),
      columns: { messageIdHdr: true, threadId: true },
    });
    // A header match alone is forgeable: anyone who learns a Message-ID (from a
    // reply, NDR, or list archive) can send In-Reply-To: <that-id> to graft
    // into the thread. Require a corroborating signal — the sender is already a
    // participant of the matched thread and the thread is recent — before
    // trusting the splice. Otherwise fall through and treat it as new mail.
    const byHeader = new Map(headerHits.map((h) => [h.messageIdHdr, h.threadId]));
    // Keep header order so the earliest-referenced thread wins the tie.
    const candidates = [
      ...new Set(headerIds.map((mid) => byHeader.get(mid)).filter((t): t is string => !!t)),
    ];
    if (candidates.length) {
      // Our own outbound mail is trusted; inbound must be corroborated.
      if (input.trustHeaders) return { threadId: candidates[0]!, joinedByHeader: true };
      const corroborated = await corroboratedThreadIds(db, candidates, input);
      const hit = candidates.find((tid) => corroborated.has(tid));
      if (hit) return { threadId: hit, joinedByHeader: true };
    }
  }

  const norm = normalizeSubject(input.subject);
  // When we have a header chain, derive a deterministic thread id from the
  // chain root. Two concurrent inbounds with the same parent then collide on
  // the same id instead of each inserting a fresh random-UUID thread. This only
  // ever creates/joins a thread keyed by the (forgeable) root id — it never
  // splices into a victim's pre-existing thread, so no corroboration is needed.
  const rootHeader = input.references?.[0] ?? input.inReplyTo ?? null;
  if (rootHeader) {
    const id = await deriveThreadId(input.mailboxId, rootHeader);
    await db
      .insert(thread)
      .values({
        id,
        mailboxId: input.mailboxId,
        subjectNorm: norm,
        lastMsgAt: new Date(),
        msgCount: 0,
        participants: input.participants,
        unreadCount: 0,
      })
      .onConflictDoNothing();
    return { threadId: id, joinedByHeader: false };
  }

  // Subject is the weakest, most error-prone signal: it only ever rescues a
  // reply whose client stripped In-Reply-To/References. Gate it so it can only
  // *join* when the message actually looks like a reply — it carries reply
  // headers, or its raw subject had a Re:/Fwd: prefix. Otherwise a bare
  // first-contact email (e.g. two separate "Welcome to Bitwarden!" signups)
  // would wrongly merge with an unrelated message that shares a subject.
  const looksLikeReply =
    !!input.inReplyTo || !!input.references?.length || REPLY_PREFIX.test(input.subject);
  if (norm && looksLikeReply) {
    const since = new Date(Date.now() - SUBJECT_WINDOW_SECONDS * 1000);
    const hits = await db.query.thread.findMany({
      where: and(
        eq(thread.mailboxId, input.mailboxId),
        eq(thread.subjectNorm, norm),
        gte(thread.lastMsgAt, since),
      ),
      orderBy: desc(thread.lastMsgAt),
      columns: { id: true, participants: true },
    });
    // Require a shared participant so two unrelated "Re: meeting" threads from
    // different people in the same week don't collapse into one.
    const addrs = new Set(
      input.participants.map((p) => p.address.trim().toLowerCase()).filter(Boolean),
    );
    const hit = hits.find((h) =>
      (h.participants ?? []).some((p) => addrs.has(p.address.trim().toLowerCase())),
    );
    if (hit) return { threadId: hit.id, joinedByHeader: false };
  }

  const id = crypto.randomUUID();
  await db.insert(thread).values({
    id,
    mailboxId: input.mailboxId,
    subjectNorm: norm,
    lastMsgAt: new Date(),
    msgCount: 0,
    participants: input.participants,
    unreadCount: 0,
  });
  return { threadId: id, joinedByHeader: false };
}

// A header match is only trusted when the inbound sender is already a known
// participant of the matched thread (participant signal) and the thread is
// still recent (recency signal). Either missing → don't splice. Batched over
// all candidates so a long References chain stays one query, not one per row.
async function corroboratedThreadIds(
  db: DB,
  threadIds: string[],
  input: ResolveThreadInput,
): Promise<Set<string>> {
  const from = input.fromAddr.trim().toLowerCase();
  if (!from) return new Set();
  const rows = await db.query.thread.findMany({
    where: inArray(thread.id, threadIds),
    columns: { id: true, participants: true, lastMsgAt: true },
  });
  const cutoff = Date.now() - HEADER_MATCH_WINDOW_SECONDS * 1000;
  const ok = new Set<string>();
  for (const t of rows) {
    if (t.lastMsgAt.getTime() < cutoff) continue;
    if ((t.participants ?? []).some((p) => p.address.trim().toLowerCase() === from)) ok.add(t.id);
  }
  return ok;
}

async function deriveThreadId(mailboxId: string, rootHeader: string): Promise<string> {
  const data = new TextEncoder().encode(`${mailboxId}\u0000${rootHeader}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Reconcile a thread's unread badge with its messages — inbound messages
// missing the SEEN flag. Call after toggling SEEN so list badges stay in sync
// (the receive path is the only other writer of unreadCount).
export async function recomputeThreadUnread(db: DB, threadId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.direction, "in"),
        sql`(${message.flags} & ${Flag.SEEN}) = 0`,
        // A trashed message shouldn't keep the thread's unread badge lit.
        sql`(${message.flags} & ${Flag.TRASH}) = 0`,
      ),
    );
  const n = rows[0]?.c ?? 0;
  await db.update(thread).set({ unreadCount: n }).where(eq(thread.id, threadId));
  return n;
}

// Reconcile a thread's cached aggregates with its surviving messages after one
// is permanently removed: message count, last-activity time, and unread badge.
// Participants aren't pruned — like bumpThread, the list only ever grows.
export async function recomputeThreadAfterMessageDelete(db: DB, threadId: string): Promise<void> {
  const rows = await db.select({ c: count() }).from(message).where(eq(message.threadId, threadId));
  const msgCount = rows[0]?.c ?? 0;

  // lastMsgAt drives list ordering; deleting the newest message must move it
  // back to the next survivor (mirrors bumpThread's sent/received timestamp).
  const latest = await db.query.message.findFirst({
    where: eq(message.threadId, threadId),
    orderBy: desc(message.createdAt),
    columns: { sentAt: true, receivedAt: true, createdAt: true },
  });
  const lastMsgAt = latest?.sentAt ?? latest?.receivedAt ?? latest?.createdAt;

  await db
    .update(thread)
    .set({ msgCount, ...(lastMsgAt ? { lastMsgAt } : {}) })
    .where(eq(thread.id, threadId));

  await recomputeThreadUnread(db, threadId);
}

export async function bumpThread(
  db: DB,
  threadId: string,
  at: Date,
  newParticipants: { name?: string; address: string }[],
  unreadDelta: number,
  // A live new message (inbound delivery or our own reply) resurfaces a trashed
  // thread: trash is thread-wide, so without this a reply to a trashed
  // conversation would stay buried in Trash. Off for historical import, which
  // must not resurrect previously-trashed threads on re-import.
  untrash = false,
): Promise<void> {
  const existing = await db.query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { participants: true, msgCount: true, unreadCount: true, trashed: true },
  });
  const prev = existing?.participants ?? [];
  const seen = new Set(prev.map((p) => p.address.toLowerCase()));
  const merged = [...prev];
  for (const p of newParticipants) {
    const key = p.address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(p);
    }
  }
  await db
    .update(thread)
    .set({
      lastMsgAt: at,
      msgCount: (existing?.msgCount ?? 0) + 1,
      unreadCount: Math.max(0, (existing?.unreadCount ?? 0) + unreadDelta),
      participants: merged,
      ...(untrash && existing?.trashed ? { trashed: false, trashedAt: null } : {}),
    })
    .where(eq(thread.id, threadId));
}
