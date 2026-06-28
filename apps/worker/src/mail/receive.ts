import { type DB, makeDB } from "@cfmail/db";
import type { AiPriority, PgpKeyEvent } from "@cfmail/db/enums";
import {
  contactKey,
  domain,
  folder,
  label,
  mailbox,
  mailboxMember,
  messageLabel,
  redirect,
  reminder,
  threadFolder,
} from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { and, eq, inArray } from "drizzle-orm";
import { getOrCreatePgpMasterKey } from "../config.ts";
import type { Env } from "../env.ts";
import { broadcastToUsers } from "../hub.ts";
import { mailboxNotDeletePending } from "../permissions.ts";
import { generateMessageInsights } from "./ai.ts";
import { isSenderBlocked } from "./blocklist.ts";
import { type IngestOptions, ingestRaw, isAuthenticated, MAX_EMAIL_BYTES } from "./ingest.ts";
import { bodyForIndex, parseMime, streamToArrayBuffer } from "./mime.ts";
import {
  decryptVerify,
  detectPgp,
  extractPublicKeyBlock,
  type PublicKeyInfo,
  readPublicKeyInfo,
  unwrapSecret,
} from "./pgp.ts";
import { notifyMailbox } from "./push.ts";
import { runRuleSends } from "./rule-sends.ts";
import { evaluateRules, type RuleOutcome } from "./rules.ts";
import { evaluateSpam, type SpamEvaluation } from "./spam.ts";
import { fetchWkdKey } from "./wkd.ts";

const latin1Decoder = new TextDecoder("latin1");
const utf8Encoder = new TextEncoder();

export async function handleInbound(
  msg: ForwardableEmailMessage,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
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
    // Skip a mailbox being hard-deleted so its address falls through to any
    // redirect — its inbound is effectively freed the moment delete is requested.
    where: and(
      eq(mailbox.domainId, dom.id),
      eq(mailbox.localPart, baseLocal),
      mailboxNotDeletePending,
    ),
    columns: {
      id: true,
      type: true,
      serviceMode: true,
      ownerUserId: true,
      expiresAt: true,
      spamFilter: true,
      spamAiTokenCap: true,
      aiFeatures: true,
      aiTokenCap: true,
      pgpMode: true,
      pgpPublicKey: true,
      pgpPrivateKeyWrapped: true,
      pgpPassphraseWrapped: true,
      pgpAutoFetch: true,
    },
  });
  if (!mb) {
    // No direct mailbox — fall back to an inbound-only redirect/alias. An exact
    // local part wins over the domain catch-all ("*"), which only fires when no
    // mailbox and no specific redirect match.
    const reds = await db.query.redirect.findMany({
      where: and(eq(redirect.domainId, dom.id), inArray(redirect.localPart, [baseLocal, "*"])),
      columns: { localPart: true, targetMailboxId: true },
    });
    const red =
      reds.find((r) => r.localPart === baseLocal) ?? reds.find((r) => r.localPart === "*");
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
          aiFeatures: true,
          aiTokenCap: true,
          pgpMode: true,
          pgpPublicKey: true,
          pgpPrivateKeyWrapped: true,
          pgpPassphraseWrapped: true,
          pgpAutoFetch: true,
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
    const rawText = latin1Decoder.decode(raw);
    const shape = detectPgp(rawText);
    let wkdCaptured = false;
    if ((shape.encrypted || shape.signed) && mb.pgpPrivateKeyWrapped && mb.pgpPassphraseWrapped) {
      const fromAddr = parsed.from?.address?.toLowerCase();
      const contact = fromAddr
        ? await db.query.contactKey.findFirst({
            where: and(eq(contactKey.mailboxId, mb.id), eq(contactKey.email, fromAddr)),
            columns: { publicKey: true },
          })
        : null;
      // When a message is signed but we have no key to check it, try the sender's
      // WKD so verification succeeds on first contact instead of going "unknown".
      let senderKey = contact?.publicKey ?? null;
      if (!senderKey && fromAddr && shape.signed && mb.pgpAutoFetch) {
        const wkd = await fetchWkdKey(fromAddr).catch(() => null);
        if (wkd) {
          senderKey = wkd.publicArmored;
          wkdCaptured = await storeDiscoveredKey(db, mb.id, fromAddr, wkd);
        }
      }
      const masterKey = await getOrCreatePgpMasterKey(db);
      const privArmored = await unwrapSecret(masterKey, mb.pgpPrivateKeyWrapped);
      const passphrase = await unwrapSecret(masterKey, mb.pgpPassphraseWrapped);
      const res = await decryptVerify({
        rawText,
        privArmored,
        passphrase,
        senderPublicKey: senderKey,
      });
      pgp = {
        encrypted: res.encrypted,
        signed: res.signed,
        verify: res.verify,
        signedBy: res.signedBy,
      };
      if (res.decryptedRaw) {
        // Keep the outer envelope/threading headers but swap in the decrypted
        // body. PGP/MIME decrypts to a full MIME entity (re-parse for body +
        // attachments); inline PGP decrypts to bare plaintext (use it verbatim —
        // no second MIME parse).
        if (res.decryptedMime) {
          const inner = await parseMime(res.decryptedRaw);
          effectiveParsed = {
            ...parsed,
            text: inner.text,
            html: inner.html,
            attachments: inner.attachments,
          };
        } else {
          effectiveParsed = { ...parsed, text: res.decryptedRaw, html: undefined, attachments: [] };
        }
        pgp.plainRaw = utf8Encoder.encode(res.decryptedRaw);
      }
    }
    // TOFU: capture an attached/inline sender public key for future encryption,
    // and flag a rotation when a known contact signs with a different key. The
    // resulting event surfaces a one-time banner in the reader.
    const keyEvent = wkdCaptured
      ? "captured"
      : await captureSenderKey(
          db,
          mb.id,
          parsed.from?.address,
          rawText,
          pgp?.signedBy ?? null,
        ).catch(() => null);
    if (pgp) pgp.keyEvent = keyEvent;
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

  // A reply landed in this thread — satisfy any pending follow-up reminders
  // ("remind me if no reply") so they never fire. Best-effort, off the delivery
  // path (invariant 8).
  await defer(
    ctx,
    db
      .update(reminder)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(reminder.threadId, threadId),
          eq(reminder.kind, "follow_up"),
          eq(reminder.status, "pending"),
        ),
      ),
  );

  // Best-effort outbound rule actions (forward / auto-reply). Never block
  // delivery — the message is already stored (invariant 8).
  await defer(
    ctx,
    runRuleSends(env, db, {
      mailboxId: mb.id,
      selfAddr: `${baseLocal}@${domainName}`,
      domainName,
      outcome,
      parsed: effectiveParsed,
      envelopeFrom: msg.from,
    }),
  );

  const memberIds = await db
    .select({ userId: mailboxMember.userId })
    .from(mailboxMember)
    .where(eq(mailboxMember.mailboxId, mb.id));
  const userIds = new Set<string>([mb.ownerUserId, ...memberIds.map((m) => m.userId)]);

  await defer(
    ctx,
    broadcastToUsers(env, [...userIds], {
      type: "new_message",
      mailboxId: mb.id,
      messageId,
      threadId,
    }),
  );

  // Best-effort AI insights then push notification, both off the SMTP-accept
  // path. The AI runs first so the push can reflect the detected priority; when
  // AI is off/exhausted/failed we fall back to "normal". Never blocks delivery
  // and never throws (invariant 8) — `defer` swallows errors and awaits inline
  // in tests (no ctx).
  const wantInsights = mb.aiFeatures && !outcome.markSpam && spam?.verdict !== "spam";
  // Don't push-notify mail filed straight into Spam, nor mail a rule already
  // auto-read or auto-filed to spam on the user's behalf.
  const wantNotify = spam?.verdict !== "spam" && !outcome.markSpam && !outcome.markRead;

  if (wantInsights || wantNotify) {
    await defer(
      ctx,
      (async () => {
        let priority: AiPriority | null = null;
        if (wantInsights) {
          priority = await generateMessageInsights(env, db, {
            mailboxId: mb.id,
            messageId,
            threadId,
            cap: mb.aiTokenCap ?? null,
            userIds: [...userIds],
            from: effectiveParsed.from?.address ?? msg.from,
            subject: effectiveParsed.subject ?? "",
            text: effectiveParsed.text,
            html: effectiveParsed.html,
          });
        }
        if (wantNotify) {
          // Surface the authentication result so a spoofed From isn't rendered
          // as a trusted sender in the notification.
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
            threadId,
            priority: priority ?? "normal",
          });
        }
      })(),
    );
  }
}

// Run a best-effort side effect off the SMTP-accept path. With an
// ExecutionContext (the live email handler) the work is handed to waitUntil so
// it runs after the response without adding latency; without one (tests, replay)
// we await it inline. Errors are swallowed either way — these steps must never
// fail delivery (invariant 8). The D1 handle stays valid past handler return, so
// waitUntil work can keep using `db`.
function defer(ctx: ExecutionContext | undefined, work: PromiseLike<unknown>): Promise<void> {
  const safe = Promise.resolve(work).then(
    () => {},
    () => {},
  );
  if (ctx) {
    ctx.waitUntil(safe);
    return Promise.resolve();
  }
  return safe;
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

// Store an auto-discovered (WKD) key for a sender we have none for. Returns true
// when it actually inserted (so the reader can announce the capture). Never
// overwrites an existing key — that path goes through explicit trust.
async function storeDiscoveredKey(
  db: DB,
  mailboxId: string,
  email: string,
  info: PublicKeyInfo,
): Promise<boolean> {
  const inserted = await db
    .insert(contactKey)
    .values({
      id: crypto.randomUUID(),
      mailboxId,
      email,
      publicKey: info.publicArmored,
      fingerprint: info.fingerprint,
      source: "wkd",
      expiresAt: info.expiresAt ? new Date(info.expiresAt) : null,
    })
    .onConflictDoNothing()
    .returning({ id: contactKey.id });
  return inserted.length > 0;
}

// Trust-on-first-use + rotation detection. If the sender attached/inlined a
// public key that claims their From address and we have none, store it (TOFU) and
// report "captured". If we already have a key but this message was signed by a
// *different* key, report "rotated" — but never silently overwrite a stored key
// (could be impersonation; the owner confirms via the reader). Best-effort.
async function captureSenderKey(
  db: DB,
  mailboxId: string,
  from: string | undefined,
  rawText: string,
  signedBy: string | null,
): Promise<PgpKeyEvent | null> {
  const fromAddr = from?.toLowerCase();
  if (!fromAddr) return null;
  const existing = await db.query.contactKey.findFirst({
    where: and(eq(contactKey.mailboxId, mailboxId), eq(contactKey.email, fromAddr)),
    columns: { fingerprint: true },
  });

  if (existing) {
    // A v4 key ID is the low 64 bits of the fingerprint. If the message was signed
    // by a key whose ID isn't a suffix of the stored fingerprint, the sender
    // rotated (or someone is forging) — flag it for the owner to resolve.
    if (signedBy && !existing.fingerprint.toLowerCase().endsWith(signedBy.toLowerCase())) {
      return "rotated";
    }
    return null;
  }

  const block = extractPublicKeyBlock(rawText);
  if (!block) return null;
  const info = await readPublicKeyInfo(block);
  // Only trust a key that actually claims this sender's address.
  if (!info.emails.includes(fromAddr)) return null;
  const inserted = await db
    .insert(contactKey)
    .values({
      id: crypto.randomUUID(),
      mailboxId,
      email: fromAddr,
      publicKey: info.publicArmored,
      fingerprint: info.fingerprint,
      source: "tofu",
      expiresAt: info.expiresAt ? new Date(info.expiresAt) : null,
    })
    .onConflictDoNothing()
    .returning({ id: contactKey.id });
  // Only announce a capture when we actually inserted (lost races insert nothing).
  return inserted.length > 0 ? "captured" : null;
}
