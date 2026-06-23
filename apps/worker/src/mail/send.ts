import type { DB } from "@cfmail/db";
import { domain, mailbox, message } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import type { SendMessageInput } from "@cfmail/shared/schemas";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { addrsToText, bodyForIndex, buildMime, snippet, type ThreadingHeaders } from "./mime.ts";
import { bumpThread, resolveThreadId } from "./threads.ts";

export async function sendFromMailbox(
  env: Env,
  db: DB,
  // null for key-authed service sends — there is no user to broadcast to.
  userId: string | null,
  input: SendMessageInput,
  // Reply/forward quote, resolved server-side (see mail/quote.ts).
  quote?: { html: string; text: string },
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

  const fromAddr = resolveFromAddr(input.fromAddress, mb.localPart, dom.name);
  const fromName = mb.displayName ?? undefined;
  const fromField: string | { name: string; email: string } = fromName
    ? { name: fromName, email: fromAddr }
    : fromAddr;
  const replyToAddr = mb.replyTo ?? undefined;
  const signature = mb.signature ?? undefined;
  let text = appendSignatureText(input.text, signature);
  let html = appendSignatureHtml(input.html, signature);
  if (quote) {
    // A quote is HTML; synthesize an HTML part from the plain composed body when
    // the user didn't write markdown, so the quoted original renders downstream.
    let baseHtml = html;
    if (!baseHtml) {
      baseHtml = appendSignatureHtml(textToHtml(input.text ?? ""), signature) ?? "";
    }
    text = `${text ?? ""}${quote.text}`;
    html = `${baseHtml}${quote.html}`;
  }

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

  const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];

  const sendHeaders: Record<string, string> = {};
  if (input.inReplyTo) sendHeaders["In-Reply-To"] = input.inReplyTo;
  if (input.references?.length) sendHeaders.References = input.references.join(" ");

  let returnedMessageId: string | undefined;
  try {
    const res = await env.EMAIL.send({
      from: fromField,
      to: input.to.map((a) => a.address),
      cc: input.cc?.length ? input.cc.map((a) => a.address) : undefined,
      bcc: input.bcc?.length ? input.bcc.map((a) => a.address) : undefined,
      replyTo: replyToAddr,
      subject: input.subject,
      text,
      html,
      headers: Object.keys(sendHeaders).length ? sendHeaders : undefined,
      attachments: attachmentBytes.length
        ? attachmentBytes.map((a) => ({
            disposition: "attachment" as const,
            filename: a.filename,
            type: a.contentType,
            content: a.data,
          }))
        : undefined,
    });
    returnedMessageId = res?.messageId;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HTTPException(502, { message: `send failed: ${detail}` });
  }

  const messageIdHdr = returnedMessageId
    ? returnedMessageId.startsWith("<")
      ? returnedMessageId
      : `<${returnedMessageId}>`
    : `<${crypto.randomUUID()}@${dom.name}>`;
  const threading: ThreadingHeaders = { messageId: messageIdHdr };
  if (input.inReplyTo) threading.inReplyTo = input.inReplyTo;
  if (input.references?.length) threading.references = input.references;

  const sentAt = new Date();
  const messageId = crypto.randomUUID();

  const { threadId } = await resolveThreadId(db, {
    mailboxId: mb.id,
    subject: input.subject,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    participants: [{ name: fromName, address: fromAddr }, ...allRecipients],
    fromAddr,
    trustHeaders: true,
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
  const bodyIndex = bodyForIndex(text, html);

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
      snippet: snippet(bodyIndex),
      bodyText: bodyIndex,
      toText: addrsToText([...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]),
      flags: Flag.SENT | Flag.SEEN,
      receivedAt: null,
      sentAt,
      rawR2Key: rawKey,
      sizeBytes: new TextEncoder().encode(raw).byteLength,
    }),
  ]);

  await Promise.all([
    bumpThread(db, threadId, sentAt, [{ name: fromName, address: fromAddr }, ...allRecipients], 0),
    userId
      ? broadcastToUsers(env, [userId], {
          type: "message_sent",
          mailboxId: mb.id,
          messageId,
          threadId,
        })
      : Promise.resolve(),
  ]);

  return { messageId, threadId };
}

// The outbound From address. Defaults to the mailbox's own address; an explicit
// override is accepted only when it's a plus-alias of the same mailbox (same
// base local part + domain), so a WRITE holder can reply from "hi+tag@" but
// never from another mailbox.
function resolveFromAddr(
  override: string | undefined,
  localPart: string,
  domainName: string,
): string {
  const base = `${localPart}@${domainName}`;
  if (!override) return base;
  const [local, dom] = override.split("@");
  const baseLocal = (local?.split("+")[0] ?? "").toLowerCase();
  if (dom?.toLowerCase() !== domainName.toLowerCase() || baseLocal !== localPart.toLowerCase()) {
    throw new HTTPException(400, {
      message: "from address must be the mailbox or a plus-alias of it",
    });
  }
  return override;
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

function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
