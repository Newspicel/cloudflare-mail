import type { DB } from "@cfmail/db";
import { domain, mailbox, message } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import type { SendMessageInput } from "@cfmail/shared/schemas";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { buildMime, buildThreadingHeaders, snippet, type ThreadingHeaders } from "./mime.ts";
import { bumpThread, resolveThreadId } from "./threads.ts";

export async function sendFromMailbox(
  env: Env,
  db: DB,
  userId: string,
  input: SendMessageInput,
): Promise<{ messageId: string; threadId: string }> {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, input.mailboxId),
    columns: {
      id: true,
      localPart: true,
      domainId: true,
      displayName: true,
      replyTo: true,
      signature: true,
    },
  });
  if (!mb) throw new HTTPException(404, { message: "mailbox not found" });

  const dom = await db.query.domain.findFirst({
    where: eq(domain.id, mb.domainId),
    columns: { name: true },
  });
  if (!dom) throw new HTTPException(500, { message: "domain missing" });

  const fromAddr = `${mb.localPart}@${dom.name}`;
  const fromName = mb.displayName ?? undefined;
  const fromFormatted = fromName ? `${escapeName(fromName)} <${fromAddr}>` : fromAddr;
  const replyToAddr = mb.replyTo ?? undefined;
  const signature = mb.signature ?? undefined;
  const text = appendSignatureText(input.text, signature);
  const html = appendSignatureHtml(input.html, signature);

  const attachmentBytes = await Promise.all(
    (input.attachments ?? []).map(async (att) => {
      const obj = await env.BLOBS.get(att.r2Key);
      if (!obj) throw new HTTPException(400, { message: `attachment missing: ${att.r2Key}` });
      const buf = await obj.arrayBuffer();
      return {
        filename: att.filename,
        contentType: att.contentType,
        data: new Uint8Array(buf),
      };
    }),
  );

  const messageIdHdr = `<${crypto.randomUUID()}@${dom.name}>`;
  const threading: ThreadingHeaders = { messageId: messageIdHdr };
  if (input.inReplyTo) threading.inReplyTo = input.inReplyTo;
  if (input.references?.length) threading.references = input.references;

  const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];

  const headers = buildThreadingHeaders(threading);
  if (replyToAddr) headers["Reply-To"] = replyToAddr;

  await env.EMAIL.send({
    from: fromFormatted,
    to: input.to.map(formatAddr),
    cc: input.cc?.length ? input.cc.map(formatAddr) : undefined,
    bcc: input.bcc?.length ? input.bcc.map(formatAddr) : undefined,
    replyTo: replyToAddr,
    subject: input.subject,
    text,
    html,
    headers,
    attachments: attachmentBytes.length
      ? attachmentBytes.map((a) => ({
          disposition: "attachment" as const,
          filename: a.filename,
          type: a.contentType,
          content: a.data,
        }))
      : undefined,
  });

  const sentAt = new Date();
  const messageId = crypto.randomUUID();

  const threadId = await resolveThreadId(db, {
    mailboxId: mb.id,
    subject: input.subject,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    participants: [{ name: fromName, address: fromAddr }, ...allRecipients],
  });

  const raw = buildMime({
    ...threading,
    from: { name: fromName, address: fromAddr },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: replyToAddr,
    subject: input.subject,
    text,
    html,
    attachments: attachmentBytes,
  });

  const rawKey = `raw/${mb.id}/sent/${messageId}.eml`;

  await Promise.all([
    env.BLOBS.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } }),
    db.insert(message).values({
      id: messageId,
      mailboxId: mb.id,
      threadId,
      direction: "out",
      messageIdHdr,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null,
      fromName: fromName ?? null,
      fromAddr,
      toAddrs: input.to,
      ccAddrs: input.cc ?? null,
      bccAddrs: input.bcc ?? null,
      subject: input.subject,
      snippet: snippet(text ?? stripHtml(html ?? "")),
      flags: Flag.SENT | Flag.SEEN,
      receivedAt: null,
      sentAt,
      rawR2Key: rawKey,
      sizeBytes: new TextEncoder().encode(raw).byteLength,
    }),
  ]);

  await Promise.all([
    bumpThread(db, threadId, sentAt, [{ name: fromName, address: fromAddr }, ...allRecipients], 0),
    broadcastToUsers(env, [userId], {
      type: "message_sent",
      mailboxId: mb.id,
      messageId,
      threadId,
    }),
  ]);

  return { messageId, threadId };
}

function formatAddr(a: { name?: string; address: string }): string {
  return a.name ? `${escapeName(a.name)} <${a.address}>` : a.address;
}

function escapeName(name: string): string {
  if (/[,<>@"]/.test(name)) return `"${name.replace(/"/g, '\\"')}"`;
  return name;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

function appendSignatureText(
  body: string | undefined,
  signature: string | undefined,
): string | undefined {
  if (!signature) return body;
  const sig = `\n\n-- \n${signature}`;
  return body ? `${body}${sig}` : sig.trimStart();
}

function appendSignatureHtml(
  body: string | undefined,
  signature: string | undefined,
): string | undefined {
  if (!signature) return body;
  if (!body) return undefined;
  const block = `<div class="signature" style="white-space:pre-wrap;color:#6b7280;margin-top:1em;">-- \n${escapeHtml(signature)}</div>`;
  return `${body}${block}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
