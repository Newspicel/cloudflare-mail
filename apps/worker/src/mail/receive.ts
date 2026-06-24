import { type DB, makeDB } from "@cfmail/db";
import {
  contactKey,
  domain,
  folder,
  label,
  mailbox,
  mailboxMember,
  messageLabel,
  redirect,
  threadFolder,
} from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { and, eq, inArray } from "drizzle-orm";
import { getOrCreatePgpMasterKey } from "../config.ts";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { isSenderBlocked } from "./blocklist.ts";
import { type IngestOptions, ingestRaw, isAuthenticated, MAX_EMAIL_BYTES } from "./ingest.ts";
import { bodyForIndex, parseMime, streamToArrayBuffer } from "./mime.ts";
import {
  decryptVerify,
  detectPgp,
  extractPublicKeyBlock,
  readPublicKeyInfo,
  unwrapSecret,
} from "./pgp.ts";
import { notifyMailbox } from "./push.ts";
import { runRuleSends } from "./rule-sends.ts";
import { evaluateRules, type RuleOutcome } from "./rules.ts";
import { evaluateSpam, type SpamEvaluation } from "./spam.ts";

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
      pgpMode: true,
      pgpPublicKey: true,
      pgpPrivateKeyWrapped: true,
      pgpPassphraseWrapped: true,
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
          pgpMode: true,
          pgpPublicKey: true,
          pgpPrivateKeyWrapped: true,
          pgpPassphraseWrapped: true,
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
  // Manual blocklist (deployment-wide): reject a matching sender with the *same*
  // generic reason as a non-existent address ("Address not found"). This neither
  // fakes a successful delivery (we don't accept-and-drop) nor reveals the block
  // (no "you're blocked" reason) — the sender just gets an ordinary
  // address-not-found bounce, indistinguishable from mailing an unknown mailbox.
  // Checked on the envelope sender first (before the body is read), then on the
  // header From after parse so a spoofed From can't hide behind a clean envelope.
  if (await isSenderBlocked(db, [msg.from])) {
    msg.setReject("Address not found");
    return;
  }

  const raw = await streamToArrayBuffer(msg.raw, MAX_EMAIL_BYTES);
  const parsed = await parseMime(raw);
  if (await isSenderBlocked(db, [parsed.from?.address])) {
    msg.setReject("Address not found");
    return;
  }

  // Gateway PGP: decrypt/verify inbound before spam + indexing so the plaintext
  // body is what gets filtered, searched, and shown. Never reject on PGP failure.
  let effectiveParsed = parsed;
  let pgp: IngestOptions["pgp"];
  if (mb.pgpMode !== "off") {
    const rawText = new TextDecoder("latin1").decode(raw);
    const shape = detectPgp(rawText);
    if ((shape.encrypted || shape.signed) && mb.pgpPrivateKeyWrapped && mb.pgpPassphraseWrapped) {
      const fromAddr = parsed.from?.address?.toLowerCase();
      const contact = fromAddr
        ? await db.query.contactKey.findFirst({
            where: and(eq(contactKey.mailboxId, mb.id), eq(contactKey.email, fromAddr)),
            columns: { publicKey: true },
          })
        : null;
      const masterKey = await getOrCreatePgpMasterKey(db);
      const privArmored = await unwrapSecret(masterKey, mb.pgpPrivateKeyWrapped);
      const passphrase = await unwrapSecret(masterKey, mb.pgpPassphraseWrapped);
      const res = await decryptVerify({
        rawText,
        privArmored,
        passphrase,
        senderPublicKey: contact?.publicKey ?? null,
      });
      pgp = {
        encrypted: res.encrypted,
        signed: res.signed,
        verify: res.verify,
        signedBy: res.signedBy,
      };
      if (res.decryptedRaw) {
        const inner = await parseMime(res.decryptedRaw);
        // Keep the outer envelope/threading headers but take the body +
        // attachments from the decrypted inner MIME.
        effectiveParsed = {
          ...parsed,
          text: inner.text,
          html: inner.html,
          attachments: inner.attachments,
        };
        pgp.plainRaw = new TextEncoder().encode(res.decryptedRaw);
      }
    }
    // TOFU: capture an attached/inline sender public key for future encryption.
    await captureTofuKey(db, mb.id, parsed.from?.address, rawText).catch(() => {});
  }

  let spam: SpamEvaluation | null = null;
  if (mb.spamFilter !== "off") {
    spam = await evaluateSpam(env, db, {
      mailboxId: mb.id,
      level: mb.spamFilter,
      aiTokenCap: mb.spamAiTokenCap ?? null,
      parsed: effectiveParsed,
      fromEnvelope: msg.from,
    });
  }

  // User rules: match the parsed message against this mailbox's filters. A
  // hardBlock SMTP-rejects before anything is stored; other actions feed into
  // the insert (flags/spam) and are applied to the message/thread after it.
  const outcome = await evaluateRules(db, mb.id, {
    fromAddr: effectiveParsed.from?.address ?? msg.from,
    fromName: effectiveParsed.from?.name,
    toAddrs: addrList(effectiveParsed.to),
    ccAddrs: addrList(effectiveParsed.cc),
    subject: effectiveParsed.subject ?? "",
    bodyText: bodyForIndex(effectiveParsed.text, effectiveParsed.html),
    deliveredTo: msg.to,
  });
  if (outcome.reject) {
    msg.setReject(outcome.reject);
    return;
  }

  const { messageId, threadId } = await ingestRaw(env, db, {
    mailboxId: mb.id,
    raw,
    parsed: effectiveParsed,
    direction: "in",
    deliveredTo: msg.to,
    flags: outcome.markRead ? Flag.SEEN : 0,
    receivedAt: new Date(),
    sentAt: null,
    spam,
    forceSpam: outcome.markSpam,
    pgp,
    live: true,
  });

  await applyRuleActions(db, outcome, mb.id, messageId, threadId);

  // Best-effort outbound rule actions (forward / auto-reply). Never block
  // delivery — the message is already stored (invariant 8).
  await runRuleSends(env, db, {
    mailboxId: mb.id,
    selfAddr: `${baseLocal}@${domainName}`,
    domainName,
    outcome,
    parsed: effectiveParsed,
    envelopeFrom: msg.from,
  }).catch(() => {});

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

  // Don't push-notify mail filed straight into Spam, nor mail a rule already
  // auto-read or auto-filed to spam on the user's behalf.
  if (spam?.verdict !== "spam" && !outcome.markSpam && !outcome.markRead) {
    // Surface the authentication result so a spoofed From isn't rendered as a
    // trusted sender in the notification.
    const fromAddr = parsed.from?.address ?? msg.from;
    const fromName = parsed.from?.name;
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
}

function addrList(
  addrs: { name?: string; address?: string }[] | undefined,
): { name?: string; address: string }[] {
  return (addrs ?? [])
    .filter((a) => a.address)
    .map((a) => (a.name ? { name: a.name, address: a.address! } : { address: a.address! }));
}

// Apply a rule outcome's label + folder actions after the message is stored.
// Both are re-validated against current state so a since-deleted label/folder (or
// one that no longer belongs to the rule's creator) is silently skipped rather
// than failing the FK insert and breaking delivery.
async function applyRuleActions(
  db: DB,
  outcome: RuleOutcome,
  mailboxId: string,
  messageId: string,
  threadId: string,
): Promise<void> {
  if (outcome.labelIds.length) {
    const valid = await db
      .select({ id: label.id })
      .from(label)
      .where(and(eq(label.mailboxId, mailboxId), inArray(label.id, outcome.labelIds)));
    await Promise.all(
      valid.map((l) =>
        db.insert(messageLabel).values({ messageId, labelId: l.id }).onConflictDoNothing(),
      ),
    );
  }

  if (outcome.folder) {
    const { userId, folderId } = outcome.folder;
    const owned = await db.query.folder.findFirst({
      where: and(eq(folder.id, folderId), eq(folder.userId, userId)),
      columns: { id: true },
    });
    if (owned) {
      await db
        .insert(threadFolder)
        .values({ userId, threadId, folderId, filedAt: new Date() })
        .onConflictDoUpdate({
          target: [threadFolder.userId, threadFolder.threadId],
          set: { folderId, filedAt: new Date() },
        });
    }
  }
}

function splitAddr(addr: string): [string | null, string | null] {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return [null, null];
  return [addr.slice(0, at), addr.slice(at + 1)];
}

// Trust-on-first-use: if the sender attached/inlined a public key that claims
// their From address and we don't already have one, store it so future replies
// can encrypt. Best-effort — callers swallow errors.
async function captureTofuKey(
  db: DB,
  mailboxId: string,
  from: string | undefined,
  rawText: string,
): Promise<void> {
  const fromAddr = from?.toLowerCase();
  if (!fromAddr) return;
  const block = extractPublicKeyBlock(rawText);
  if (!block) return;
  const existing = await db.query.contactKey.findFirst({
    where: and(eq(contactKey.mailboxId, mailboxId), eq(contactKey.email, fromAddr)),
    columns: { id: true },
  });
  if (existing) return;
  const info = await readPublicKeyInfo(block);
  // Only trust a key that actually claims this sender's address.
  if (!info.emails.includes(fromAddr)) return;
  await db
    .insert(contactKey)
    .values({
      id: crypto.randomUUID(),
      mailboxId,
      email: fromAddr,
      publicKey: info.publicArmored,
      fingerprint: info.fingerprint,
      source: "tofu",
    })
    .onConflictDoNothing();
}
