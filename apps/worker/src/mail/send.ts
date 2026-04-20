import type { DB } from "@cfmail/db";
import { domain, mailbox, message } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import type { SendMessageInput } from "@cfmail/shared/schemas";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { buildMime, snippet } from "./mime.ts";
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

  const attachmentBytes: { filename: string; contentType: string; data: Uint8Array }[] = [];
  for (const att of input.attachments ?? []) {
    const obj = await env.BLOBS.get(att.r2Key);
    if (!obj) throw new HTTPException(400, { message: `attachment missing: ${att.r2Key}` });
    const buf = await obj.arrayBuffer();
    attachmentBytes.push({
      filename: att.filename,
      contentType: att.contentType,
      data: new Uint8Array(buf),
    });
  }

  const messageIdHdr = `<${crypto.randomUUID()}@${dom.name}>`;
  const headers: Record<string, string> = { "Message-ID": messageIdHdr };
  if (input.inReplyTo) headers["In-Reply-To"] = input.inReplyTo;
  if (input.references?.length) headers["References"] = input.references.join(" ");

  const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];

  await env.EMAIL.send({
    from: fromFormatted,
    to: input.to.map(formatAddr),
    cc: input.cc?.length ? input.cc.map(formatAddr) : undefined,
    bcc: input.bcc?.length ? input.bcc.map(formatAddr) : undefined,
    subject: input.subject,
    text: input.text,
    html: input.html,
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
    from: { name: fromName, address: fromAddr },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    messageId: messageIdHdr,
    attachments: attachmentBytes,
  });

  const rawKey = `raw/${mb.id}/sent/${messageId}.eml`;
  await env.BLOBS.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });

  await db.insert(message).values({
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
    snippet: snippet(input.text ?? stripHtml(input.html ?? "")),
    flags: Flag.SENT | Flag.SEEN,
    receivedAt: null,
    sentAt,
    rawR2Key: rawKey,
    sizeBytes: new TextEncoder().encode(raw).byteLength,
  });

  await bumpThread(
    db,
    threadId,
    sentAt,
    [{ name: fromName, address: fromAddr }, ...allRecipients],
    0,
  );

  await broadcastToUsers(env, [userId], {
    type: "message_sent",
    mailboxId: mb.id,
    messageId,
    threadId,
  });

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
