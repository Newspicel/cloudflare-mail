import type { DB } from "@cfmail/db";
import { message, thread } from "@cfmail/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { normalizeSubject } from "./mime.ts";

const SUBJECT_WINDOW_SECONDS = 60 * 60 * 24 * 7;

export interface ResolveThreadInput {
  mailboxId: string;
  subject: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  participants: { name?: string; address: string }[];
}

export async function resolveThreadId(db: DB, input: ResolveThreadInput): Promise<string> {
  const headerIds = [
    ...(input.references ?? []),
    ...(input.inReplyTo ? [input.inReplyTo] : []),
  ].filter(Boolean);

  for (const mid of headerIds) {
    const hit = await db.query.message.findFirst({
      where: and(eq(message.mailboxId, input.mailboxId), eq(message.messageIdHdr, mid)),
      columns: { threadId: true },
    });
    if (hit) return hit.threadId;
  }

  const norm = normalizeSubject(input.subject);
  // When we have a header chain, derive a deterministic thread id from the
  // chain root. Two concurrent inbounds with the same parent then collide on
  // the same id instead of each inserting a fresh random-UUID thread.
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
    return id;
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
    if (hit) return hit.id;
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
  return id;
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
