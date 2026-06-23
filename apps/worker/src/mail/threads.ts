import type { DB } from "@cfmail/db";
import { message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { normalizeSubject } from "./mime.ts";

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
    const headerHits = await Promise.all(
      headerIds.map((mid) =>
        db.query.message.findFirst({
          where: and(eq(message.mailboxId, input.mailboxId), eq(message.messageIdHdr, mid)),
          columns: { threadId: true },
        }),
      ),
    );
    // A header match alone is forgeable: anyone who learns a Message-ID (from a
    // reply, NDR, or list archive) can send In-Reply-To: <that-id> to graft
    // into the thread. Require a corroborating signal — the sender is already a
    // participant of the matched thread and the thread is recent — before
    // trusting the splice. Otherwise fall through and treat it as new mail.
    const candidates = [...new Set(headerHits.filter((h) => h).map((h) => h!.threadId))];
    if (candidates.length) {
      // Our own outbound mail is trusted; inbound must be corroborated.
      if (input.trustHeaders) return { threadId: candidates[0]!, joinedByHeader: true };
      const ok = await Promise.all(candidates.map((tid) => corroboratesThread(db, tid, input)));
      const idx = ok.findIndex(Boolean);
      if (idx >= 0) return { threadId: candidates[idx]!, joinedByHeader: true };
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

  if (norm) {
    const since = new Date(Date.now() - SUBJECT_WINDOW_SECONDS * 1000);
    const hit = await db.query.thread.findFirst({
      where: and(
        eq(thread.mailboxId, input.mailboxId),
        eq(thread.subjectNorm, norm),
        gte(thread.lastMsgAt, since),
      ),
      orderBy: desc(thread.lastMsgAt),
      columns: { id: true },
    });
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
// still recent (recency signal). Either missing → don't splice.
async function corroboratesThread(
  db: DB,
  threadId: string,
  input: ResolveThreadInput,
): Promise<boolean> {
  const t = await db.query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { participants: true, lastMsgAt: true },
  });
  if (!t) return false;
  if (t.lastMsgAt.getTime() < Date.now() - HEADER_MATCH_WINDOW_SECONDS * 1000) return false;
  const from = input.fromAddr.trim().toLowerCase();
  if (!from) return false;
  return (t.participants ?? []).some((p) => p.address.trim().toLowerCase() === from);
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
      ),
    );
  const n = rows[0]?.c ?? 0;
  await db.update(thread).set({ unreadCount: n }).where(eq(thread.id, threadId));
  return n;
}

export async function bumpThread(
  db: DB,
  threadId: string,
  at: Date,
  newParticipants: { name?: string; address: string }[],
  unreadDelta: number,
): Promise<void> {
  const existing = await db.query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { participants: true, msgCount: true, unreadCount: true },
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
    })
    .where(eq(thread.id, threadId));
}
