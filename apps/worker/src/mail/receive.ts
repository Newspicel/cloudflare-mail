import { makeDB } from "@cfmail/db";
import {
  attachment,
  domain,
  mailbox,
  mailboxMember,
  message,
  redirect,
  thread,
} from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { and, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { addrsToText, bodyForIndex, parseMime, snippet, streamToArrayBuffer } from "./mime.ts";
import { notifyMailbox } from "./push.ts";
import type { AuthResult } from "./spam.ts";
import { evaluateSpam, type SpamEvaluation } from "./spam.ts";
import { bumpThread, resolveThreadId } from "./threads.ts";

const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

export async function handleInbound(msg: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = makeDB(env.DB);

  const [localPart, domainName] = splitAddr(msg.to);
  if (!localPart || !domainName) {
    msg.setReject("Address invalid");
    return;
  }
  // Plus/sub-addressing: match the base local part ("hi+tag" -> "hi") while the
  // full envelope recipient is preserved in deliveredTo. A leading "+" has no
  // base, so fall back to the full local part.
  const baseLocal = (localPart.split("+")[0] || localPart).toLowerCase();

  const dom = await db.query.domain.findFirst({
    where: eq(domain.name, domainName.toLowerCase()),
    columns: { id: true },
  });
  if (!dom) {
    msg.setReject("Domain not routed");
    return;
  }

  let mb = await db.query.mailbox.findFirst({
    where: and(eq(mailbox.domainId, dom.id), eq(mailbox.localPart, baseLocal)),
    columns: {
      id: true,
      type: true,
      serviceMode: true,
      ownerUserId: true,
      expiresAt: true,
      spamFilter: true,
      spamAiTokenCap: true,
    },
  });
  if (!mb) {
    // No direct mailbox — fall back to an inbound-only redirect/alias. An exact
    // local part wins over the domain catch-all ("*"), which only fires when no
    // mailbox and no specific redirect match.
    const red =
      (await db.query.redirect.findFirst({
        where: and(eq(redirect.domainId, dom.id), eq(redirect.localPart, baseLocal)),
        columns: { targetMailboxId: true },
      })) ??
      (await db.query.redirect.findFirst({
        where: and(eq(redirect.domainId, dom.id), eq(redirect.localPart, "*")),
        columns: { targetMailboxId: true },
      }));
    if (red) {
      mb = await db.query.mailbox.findFirst({
        where: eq(mailbox.id, red.targetMailboxId),
        columns: {
          id: true,
          type: true,
          serviceMode: true,
          ownerUserId: true,
          expiresAt: true,
          spamFilter: true,
          spamAiTokenCap: true,
        },
      });
    }
  }
  if (!mb) {
    msg.setReject("Address not found");
    return;
  }
  if (mb.expiresAt && mb.expiresAt.getTime() < Date.now()) {
    msg.setReject("Mailbox expired");
    return;
  }
  // Send-only service mailboxes hard-bounce inbound; duplex ones fall through
  // and store the message for API polling.
  if (mb.type === "service" && mb.serviceMode === "send") {
    msg.setReject("Send-only address");
    return;
  }
  if (msg.from.trim().toLowerCase() === msg.to.trim().toLowerCase()) {
    msg.setReject("Sender equals recipient");
    return;
  }

  const raw = await streamToArrayBuffer(msg.raw, MAX_EMAIL_BYTES);
  const size = raw.byteLength;

  const rawKey = `raw/${mb.id}/${crypto.randomUUID()}.eml`;
  await env.BLOBS.put(rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const parsed = await parseMime(raw);

  let spam: SpamEvaluation | null = null;
  if (mb.spamFilter !== "off") {
    spam = await evaluateSpam(env, db, {
      mailboxId: mb.id,
      level: mb.spamFilter,
      aiTokenCap: mb.spamAiTokenCap ?? null,
      parsed,
      fromEnvelope: msg.from,
    });
  }

  const messageId = crypto.randomUUID();
  const toAddrs = (parsed.to ?? []).map((a) => normalizeAddr(a));
  const ccAddrs = (parsed.cc ?? []).map((a) => normalizeAddr(a));
  const fromAddr = parsed.from?.address ?? msg.from;
  const fromName = parsed.from?.name ?? undefined;

  const fromParticipant: { name?: string; address: string } = { address: fromAddr };
  if (fromName) fromParticipant.name = fromName;
  const participants = [fromParticipant, ...toAddrs, ...ccAddrs].filter((p) => p.address);

  const { threadId, joinedByHeader } = await resolveThreadId(db, {
    mailboxId: mb.id,
    subject: parsed.subject ?? "",
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : null,
    participants,
    fromAddr,
  });

  // A brand-new thread is auto-filed under Spam — never yank an existing
  // legitimate conversation into the spam folder over a single message. The one
  // exception is a header-based join of unauthenticated mail: those splices are
  // attacker-influenced, so we don't let them launder spam into a real thread.
  const existingThread = await db.query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { msgCount: true },
  });
  const isNewThread = (existingThread?.msgCount ?? 0) === 0;
  const fileSpam =
    !!spam?.folderSpam && (isNewThread || (joinedByHeader && !isAuthenticated(spam.auth)));

  const receivedAt = new Date();
  const bodyIndex = bodyForIndex(parsed.text, parsed.html);

  await db.insert(message).values({
    id: messageId,
    mailboxId: mb.id,
    threadId,
    direction: "in",
    messageIdHdr: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : null,
    fromName: fromName ?? null,
    fromAddr,
    deliveredTo: msg.to,
    toAddrs,
    ccAddrs: ccAddrs.length ? ccAddrs : null,
    bccAddrs: null,
    subject: parsed.subject ?? "",
    snippet: snippet(bodyIndex),
    bodyText: bodyIndex,
    toText: addrsToText([...toAddrs, ...ccAddrs]),
    flags: 0,
    receivedAt,
    sentAt: null,
    rawR2Key: rawKey,
    sizeBytes: size,
    spamVerdict: spam?.verdict ?? null,
    spamScore: spam?.score ?? null,
    spamReasons: spam?.reasons.length ? spam.reasons : null,
    spamAuth: spam ? spam.auth : null,
  });

  if (fileSpam) {
    await db.update(thread).set({ spam: true }).where(eq(thread.id, threadId));
  }

  await Promise.all(
    (parsed.attachments ?? []).map(async (att, idx) => {
      const attKey = `att/${messageId}/${idx}-${sanitizeFilename(att.filename ?? `file-${idx}`)}`;
      const bytes =
        typeof att.content === "string"
          ? new TextEncoder().encode(att.content)
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

  await bumpThread(db, threadId, receivedAt, participants, +1);

  const memberIds = await db
    .select({ userId: mailboxMember.userId })
    .from(mailboxMember)
    .where(eq(mailboxMember.mailboxId, mb.id));
  const userIds = new Set<string>([mb.ownerUserId, ...memberIds.map((m) => m.userId)]);

  await broadcastToUsers(env, [...userIds], {
    type: "new_message",
    mailboxId: mb.id,
    messageId,
    threadId,
  });

  // Don't push-notify mail filed straight into Spam.
  if (spam?.verdict !== "spam") {
    // Surface the authentication result so a spoofed From isn't rendered as a
    // trusted sender in the notification.
    const sender = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
    const unverified = spam ? !isAuthenticated(spam.auth) : false;
    await notifyMailbox(db, {
      mailboxId: mb.id,
      userIds: [...userIds],
      title: unverified ? `⚠ Unverified sender: ${sender}` : sender,
      body: parsed.subject?.trim() ? parsed.subject : "(no subject)",
      url: `/app/m/${mb.id}/t/${threadId}`,
    });
  }

  // Mark as unseen by default (the Flag.SEEN bit is 0 so nothing to do).
  void Flag;
}

// The sender is authenticated when DMARC passes, or both SPF and DKIM pass.
// Unauthenticated mail is treated as potentially forged for spam-filing and
// notification purposes.
function isAuthenticated(auth: AuthResult): boolean {
  return auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass");
}

function normalizeAddr(a: { name?: string; address?: string }): { name?: string; address: string } {
  const out: { name?: string; address: string } = { address: a.address ?? "" };
  if (a.name) out.name = a.name;
  return out;
}

function splitAddr(addr: string): [string | null, string | null] {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return [null, null];
  return [addr.slice(0, at), addr.slice(at + 1)];
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 128);
}
