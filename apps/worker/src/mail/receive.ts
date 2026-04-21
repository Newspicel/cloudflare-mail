import { makeDB } from "@cfmail/db";
import { attachment, domain, mailbox, mailboxMember, message } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { and, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { parseMime, snippet, streamToArrayBuffer } from "./mime.ts";
import { bumpThread, resolveThreadId } from "./threads.ts";

const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

export async function handleInbound(msg: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = makeDB(env.DB);

  const [localPart, domainName] = splitAddr(msg.to);
  if (!localPart || !domainName) {
    msg.setReject("Address invalid");
    return;
  }

  const dom = await db.query.domain.findFirst({
    where: eq(domain.name, domainName.toLowerCase()),
    columns: { id: true },
  });
  if (!dom) {
    msg.setReject("Domain not routed");
    return;
  }

  const mb = await db.query.mailbox.findFirst({
    where: and(eq(mailbox.domainId, dom.id), eq(mailbox.localPart, localPart.toLowerCase())),
    columns: { id: true, type: true, ownerUserId: true, expiresAt: true },
  });
  if (!mb) {
    msg.setReject("Address not found");
    return;
  }
  if (mb.expiresAt && mb.expiresAt.getTime() < Date.now()) {
    msg.setReject("Mailbox expired");
    return;
  }
  if (mb.type === "service") {
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

  const messageId = crypto.randomUUID();
  const toAddrs = (parsed.to ?? []).map((a) => normalizeAddr(a));
  const ccAddrs = (parsed.cc ?? []).map((a) => normalizeAddr(a));
  const fromAddr = parsed.from?.address ?? msg.from;
  const fromName = parsed.from?.name ?? undefined;

  const fromParticipant: { name?: string; address: string } = { address: fromAddr };
  if (fromName) fromParticipant.name = fromName;
  const participants = [fromParticipant, ...toAddrs, ...ccAddrs].filter((p) => p.address);

  const threadId = await resolveThreadId(db, {
    mailboxId: mb.id,
    subject: parsed.subject ?? "",
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : null,
    participants,
  });

  const receivedAt = new Date();

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
    toAddrs,
    ccAddrs: ccAddrs.length ? ccAddrs : null,
    bccAddrs: null,
    subject: parsed.subject ?? "",
    snippet: snippet(parsed.text ?? stripHtml(parsed.html ?? "")),
    flags: 0,
    receivedAt,
    sentAt: null,
    rawR2Key: rawKey,
    sizeBytes: size,
  });

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

  // Mark as unseen by default (the Flag.SEEN bit is 0 so nothing to do).
  void Flag;
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}
