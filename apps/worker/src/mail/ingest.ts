import type { DB } from "@cfmail/db";
import type { PgpVerify } from "@cfmail/db/enums";
import { attachment, message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import {
  addrsToText,
  bodyForIndex,
  extractUnsubscribe,
  type ParsedEmail,
  parseMime,
  snippet,
} from "./mime.ts";
import type { AuthResult, SpamEvaluation } from "./spam.ts";
import { bumpThread, resolveThreadId } from "./threads.ts";

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

export interface IngestOptions {
  mailboxId: string;
  raw: ArrayBuffer;
  // Pre-parsed message — callers that already parsed (e.g. import, to infer
  // direction/date) pass it to avoid a second parse. Otherwise we parse here.
  parsed?: ParsedEmail;
  direction: "in" | "out";
  deliveredTo: string | null;
  flags: number;
  receivedAt: Date | null;
  sentAt: Date | null;
  // Spam evaluation result, or null to skip spam fields and auto-filing (import).
  spam: SpamEvaluation | null;
  // A matched markSpam rule files the thread to Spam regardless of the spam
  // verdict or new/existing-thread heuristic (explicit user intent).
  forceSpam?: boolean;
  // Live delivery (the `email` handler) vs. historical import. A live message
  // resurfaces a trashed thread; import must not resurrect old trash.
  live?: boolean;
  // Gateway PGP (invariant 17). When `raw` is ciphertext we keep it at rawR2Key
  // as evidence and store the decrypted .eml (`pgp.plainRaw`) at plainR2Key, which
  // the body endpoint serves. `parsed` should already reflect the plaintext body.
  pgp?: {
    encrypted: boolean;
    signed: boolean;
    verify: PgpVerify | null;
    signedBy: string | null;
    plainRaw?: Uint8Array;
  };
}

export interface IngestResult {
  messageId: string;
  threadId: string;
  isNewThread: boolean;
  joinedByHeader: boolean;
}

// Shared core behind both the live `email` handler and the import endpoint:
// archive raw to R2, parse, resolve a thread, insert the message + attachments,
// and bump thread metadata. Notifications and envelope/mailbox resolution stay
// with the callers.
export async function ingestRaw(env: Env, db: DB, opts: IngestOptions): Promise<IngestResult> {
  const { mailboxId, raw, spam } = opts;
  const size = raw.byteLength;

  const rawKey = `raw/${mailboxId}/${crypto.randomUUID()}.eml`;
  await env.BLOBS.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });

  // For decrypted inbound mail, archive the plaintext .eml separately; the body
  // endpoint reads it while the original ciphertext stays at rawKey.
  let plainKey: string | null = null;
  if (opts.pgp?.plainRaw) {
    plainKey = `plain/${mailboxId}/${crypto.randomUUID()}.eml`;
    await env.BLOBS.put(plainKey, opts.pgp.plainRaw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
  }

  const parsed = opts.parsed ?? (await parseMime(raw));

  const messageId = crypto.randomUUID();
  const toAddrs = (parsed.to ?? []).map((a) => normalizeAddr(a));
  const ccAddrs = (parsed.cc ?? []).map((a) => normalizeAddr(a));
  const fromAddr = parsed.from?.address ?? "";
  const fromName = parsed.from?.name ?? undefined;

  const fromParticipant: { name?: string; address: string } = { address: fromAddr };
  if (fromName) fromParticipant.name = fromName;
  const participants = [fromParticipant, ...toAddrs, ...ccAddrs].filter((p) => p.address);

  const references = parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : null;
  const { threadId, joinedByHeader } = await resolveThreadId(db, {
    mailboxId,
    subject: parsed.subject ?? "",
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    participants,
    fromAddr,
    // Our own outbound mail is trusted; imported "out" copies likewise carry
    // headers we don't need to corroborate against a spoofing sender.
    trustHeaders: opts.direction === "out",
  });

  const existingThread = await db.query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { msgCount: true },
  });
  const isNewThread = (existingThread?.msgCount ?? 0) === 0;

  // A brand-new thread is auto-filed under Spam — never yank an existing
  // legitimate conversation into the spam folder over a single message. The one
  // exception is a header-based join of unauthenticated mail: those splices are
  // attacker-influenced. Import passes spam=null, so nothing is ever filed.
  const fileSpam =
    !!opts.forceSpam ||
    (!!spam?.folderSpam && (isNewThread || (joinedByHeader && !isAuthenticated(spam.auth))));

  const bodyIndex = bodyForIndex(parsed.text, parsed.html);
  const unsub = extractUnsubscribe(parsed);

  await db.insert(message).values({
    id: messageId,
    mailboxId,
    threadId,
    direction: opts.direction,
    messageIdHdr: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    fromName: fromName ?? null,
    fromAddr,
    deliveredTo: opts.deliveredTo,
    toAddrs,
    ccAddrs: ccAddrs.length ? ccAddrs : null,
    bccAddrs: null,
    subject: parsed.subject ?? "",
    snippet: snippet(bodyIndex),
    bodyText: bodyIndex,
    toText: addrsToText([...toAddrs, ...ccAddrs]),
    flags: opts.flags,
    receivedAt: opts.receivedAt,
    sentAt: opts.sentAt,
    rawR2Key: rawKey,
    sizeBytes: size,
    spamVerdict: spam?.verdict ?? null,
    spamScore: spam?.score ?? null,
    spamReasons: spam?.reasons.length ? spam.reasons : null,
    spamAuth: spam ? spam.auth : null,
    listUnsubscribe: unsub.listUnsubscribe,
    listUnsubscribePost: unsub.listUnsubscribePost,
    pgpEncrypted: opts.pgp?.encrypted ?? false,
    pgpSigned: opts.pgp?.signed ?? false,
    pgpVerify: opts.pgp?.verify ?? null,
    pgpSignedBy: opts.pgp?.signedBy ?? null,
    plainR2Key: plainKey,
  });

  if (fileSpam) {
    await db.update(thread).set({ spam: true }).where(eq(thread.id, threadId));
  }

  await Promise.all(
    (parsed.attachments ?? []).map(async (att, idx) => {
      const attKey = `att/${messageId}/${idx}-${sanitizeFilename(att.filename ?? `file-${idx}`)}`;
      const bytes =
        typeof att.content === "string"
          ? utf8Encoder.encode(att.content)
          : new Uint8Array(att.content);
      await env.BLOBS.put(attKey, bytes, {
        httpMetadata: { contentType: att.mimeType ?? "application/octet-stream" },
      });
      await db.insert(attachment).values({
        id: crypto.randomUUID(),
        messageId,
        filename: att.filename ?? `file-${idx}`,
        contentType: att.mimeType ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
        r2Key: attKey,
        inline: att.disposition === "inline",
        contentId: att.contentId ?? null,
      });
    }),
  );

  // Unread badge only moves for inbound mail that arrives unseen.
  const unreadDelta = opts.direction === "in" && !(opts.flags & Flag.SEEN) ? 1 : 0;
  const at = opts.receivedAt ?? opts.sentAt ?? new Date();
  await bumpThread(db, threadId, at, participants, unreadDelta, !!opts.live);

  return { messageId, threadId, isNewThread, joinedByHeader };
}

// The sender is authenticated when DMARC passes, or both SPF and DKIM pass.
// Unauthenticated mail is treated as potentially forged for spam-filing.
export function isAuthenticated(auth: AuthResult): boolean {
  return auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass");
}

function normalizeAddr(a: { name?: string; address?: string }): { name?: string; address: string } {
  const out: { name?: string; address: string } = { address: a.address ?? "" };
  if (a.name) out.name = a.name;
  return out;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 128);
}
