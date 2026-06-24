import { EmailMessage } from "cloudflare:email";
import type { DB } from "@cfmail/db";
import { contactKey, domain, mailbox, message, reminder } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import type { SendMessageInput } from "@cfmail/shared/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { getOrCreatePgpMasterKey } from "../config.ts";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { addrsToText, bodyForIndex, buildMime, snippet, type ThreadingHeaders } from "./mime.ts";
import {
  buildEncryptedMime,
  buildSignedMime,
  type MailContent,
  type PgpHeaders,
  unwrapSecret,
} from "./pgp.ts";
import { bumpThread, resolveThreadId } from "./threads.ts";

export async function sendFromMailbox(
  env: Env,
  db: DB,
  // null for key-authed service sends — there is no user to broadcast to.
  userId: string | null,
  input: SendMessageInput,
  // Reply/forward quote, resolved server-side (see mail/quote.ts).
  quote?: { html: string; text: string },
): Promise<{ messageId: string; threadId: string; pgpWarning?: string }> {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, input.mailboxId),
    columns: {
      id: true,
      localPart: true,
      domainId: true,
      displayName: true,
      replyTo: true,
      signature: true,
      pgpMode: true,
      pgpPublicKey: true,
      pgpPrivateKeyWrapped: true,
      pgpPassphraseWrapped: true,
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
        inline: att.inline ?? false,
        contentId: att.contentId,
      };
    }),
  );

  const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];

  const sendHeaders: Record<string, string> = {};
  if (input.inReplyTo) sendHeaders["In-Reply-To"] = input.inReplyTo;
  if (input.references?.length) sendHeaders.References = input.references.join(" ");

  const sentAt = new Date();
  const messageId = crypto.randomUUID();

  // Gateway PGP: when the mailbox has a keypair and PGP is on, sign/encrypt and
  // send a raw PGP/MIME message per recipient (invariant 4 exception). Otherwise
  // the normal structured send path. Either way we archive plaintext locally
  // (below) so search/threading keep working.
  const pgpEnabled =
    mb.pgpMode !== "off" &&
    !!mb.pgpPublicKey &&
    !!mb.pgpPrivateKeyWrapped &&
    !!mb.pgpPassphraseWrapped;

  let messageIdHdr: string;
  let pgpEncrypted = false;
  let pgpSigned = false;
  let pgpWarning: string | undefined;

  if (!pgpEnabled) {
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
          ? attachmentBytes.map((a) =>
              a.inline && a.contentId
                ? {
                    disposition: "inline" as const,
                    contentId: a.contentId,
                    filename: a.filename,
                    type: a.contentType,
                    content: a.data,
                  }
                : {
                    disposition: "attachment" as const,
                    filename: a.filename,
                    type: a.contentType,
                    content: a.data,
                  },
            )
          : undefined,
      });
      returnedMessageId = res?.messageId;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, { message: `send failed: ${detail}` });
    }
    messageIdHdr = returnedMessageId
      ? returnedMessageId.startsWith("<")
        ? returnedMessageId
        : `<${returnedMessageId}>`
      : `<${messageId}@${dom.name}>`;
  } else {
    messageIdHdr = `<${messageId}@${dom.name}>`;
    const meta = await sendPgp(env, db, {
      mailboxId: mb.id,
      pgpMode: mb.pgpMode,
      pgpPublicKey: mb.pgpPublicKey!,
      pgpPrivateKeyWrapped: mb.pgpPrivateKeyWrapped!,
      pgpPassphraseWrapped: mb.pgpPassphraseWrapped!,
      fromAddr,
      fromName,
      replyToAddr,
      input,
      text,
      html,
      attachmentBytes,
      allRecipients,
      messageIdHdr,
      date: sentAt,
    });
    pgpEncrypted = meta.encrypted;
    pgpSigned = meta.signed;
    pgpWarning = meta.warning;
  }

  const threading: ThreadingHeaders = { messageId: messageIdHdr };
  if (input.inReplyTo) threading.inReplyTo = input.inReplyTo;
  if (input.references?.length) threading.references = input.references;

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
      pgpEncrypted,
      pgpSigned,
    }),
  ]);

  await Promise.all([
    bumpThread(
      db,
      threadId,
      sentAt,
      [{ name: fromName, address: fromAddr }, ...allRecipients],
      0,
      true,
    ),
    userId
      ? broadcastToUsers(env, [userId], {
          type: "message_sent",
          mailboxId: mb.id,
          messageId,
          threadId,
        })
      : Promise.resolve(),
  ]);

  // Follow-up reminder: "remind me if no reply in N days". Personal to the
  // sender, so skipped for key-authed service sends (no user). The cron fires it
  // after the window; an inbound reply on this thread cancels it (mail/receive.ts).
  if (userId && input.followUpDays) {
    const remindAt = new Date(sentAt.getTime() + input.followUpDays * 24 * 60 * 60 * 1000);
    await db.insert(reminder).values({
      id: crypto.randomUUID(),
      userId,
      mailboxId: mb.id,
      threadId,
      messageId,
      kind: "follow_up",
      remindAt,
      subject: input.subject,
    });
  }

  return pgpWarning ? { messageId, threadId, pgpWarning } : { messageId, threadId };
}

interface PgpSendArgs {
  mailboxId: string;
  pgpMode: "off" | "sign" | "sign_encrypt";
  pgpPublicKey: string;
  pgpPrivateKeyWrapped: string;
  pgpPassphraseWrapped: string;
  fromAddr: string;
  fromName: string | undefined;
  replyToAddr: string | undefined;
  input: SendMessageInput;
  text: string | undefined;
  html: string | undefined;
  attachmentBytes: {
    filename: string;
    contentType: string;
    data: Uint8Array;
    inline?: boolean;
    contentId?: string;
  }[];
  allRecipients: { name?: string; address: string }[];
  messageIdHdr: string;
  date: Date;
}

// Build a signed or sign+encrypted PGP/MIME message and deliver it raw, once per
// envelope recipient. Encryption needs a public key for every recipient; when one
// is missing we fall back to signed-only (never block the send) and warn.
async function sendPgp(
  env: Env,
  db: DB,
  args: PgpSendArgs,
): Promise<{ encrypted: boolean; signed: boolean; warning?: string }> {
  const masterKey = await getOrCreatePgpMasterKey(db);
  const privArmored = await unwrapSecret(masterKey, args.pgpPrivateKeyWrapped);
  const passphrase = await unwrapSecret(masterKey, args.pgpPassphraseWrapped);

  const uniqAddrs = [...new Set(args.allRecipients.map((a) => a.address.toLowerCase()))];
  const contacts = uniqAddrs.length
    ? await db.query.contactKey.findMany({
        where: and(eq(contactKey.mailboxId, args.mailboxId), inArray(contactKey.email, uniqAddrs)),
        columns: { email: true, publicKey: true },
      })
    : [];
  const keyByEmail = new Map(contacts.map((c) => [c.email, c.publicKey]));
  const allHaveKeys = uniqAddrs.length > 0 && uniqAddrs.every((a) => keyByEmail.has(a));
  const encrypt = args.pgpMode === "sign_encrypt" && allHaveKeys;

  const headers: PgpHeaders = {
    from: { name: args.fromName, address: args.fromAddr },
    to: args.input.to,
    cc: args.input.cc,
    replyTo: args.replyToAddr,
    subject: args.input.subject,
    messageId: args.messageIdHdr,
    inReplyTo: args.input.inReplyTo,
    references: args.input.references,
    date: args.date,
  };
  const content: MailContent = {
    text: args.text,
    html: args.html,
    attachments: args.attachmentBytes,
  };

  let raw: string;
  let meta: { encrypted: boolean; signed: boolean; warning?: string };
  if (encrypt) {
    // Encrypt to every recipient key plus our own, so the sender can read the
    // archived copy and each recipient can decrypt the same blob.
    const recipientKeys = [...new Set([...keyByEmail.values(), args.pgpPublicKey])];
    raw = await buildEncryptedMime(headers, content, privArmored, passphrase, recipientKeys);
    meta = { encrypted: true, signed: true };
  } else {
    raw = await buildSignedMime(headers, content, privArmored, passphrase);
    meta = { encrypted: false, signed: true };
    if (args.pgpMode === "sign_encrypt") {
      meta.warning = "Sent signed-only — no PGP key on file for one or more recipients.";
    }
  }

  const envelopeAddrs = [...new Set(args.allRecipients.map((a) => a.address))];
  await Promise.all(
    envelopeAddrs.map(async (to) => {
      try {
        await env.EMAIL.send(new EmailMessage(args.fromAddr, to, raw));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new HTTPException(502, { message: `send failed: ${detail}` });
      }
    }),
  );
  return meta;
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
