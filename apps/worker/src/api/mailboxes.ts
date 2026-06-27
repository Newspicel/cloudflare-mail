import type { DB } from "@cfmail/db";
import {
  contactKey,
  domain,
  mailbox,
  mailboxAiUsage,
  mailboxInvite,
  mailboxMember,
  mailboxSpamUsage,
  message,
  thread,
  threadFolder,
  user,
} from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { grant, Perm } from "@cfmail/shared/permissions";
import type {
  ContactKeysDto,
  MailboxInvitesDto,
  MailboxListDto,
  MailboxMembersDto,
  MailboxSettingsDto,
  PgpKeyResultDto,
} from "@cfmail/shared/responses";
import {
  addContactKey,
  createMailbox,
  grantMember,
  importPgpKey,
  type PgpMode,
  updateMailboxSettings,
} from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getOrCreatePgpMasterKey } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { ingestRaw, MAX_EMAIL_BYTES } from "../mail/ingest.ts";
import { bodyForIndex, parseMime } from "../mail/mime.ts";
import {
  generateKeypair,
  importPrivateKey,
  type MailboxKeyMaterial,
  readPublicKeyInfo,
  wrapSecret,
} from "../mail/pgp.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
import { requireUser } from "../middleware.ts";
import { mailboxNotDeletePending, mailboxNotPurging, requirePerm } from "../permissions.ts";

export function mailboxesRoutes() {
  const r = new Hono<AppBindings>();

  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;

    // Owned + shared mailboxes in one pass: left-join membership for this user so
    // a row is owned (ownerUserId match) and/or shared (non-null perms). Owner
    // wins when both — it gets full perms regardless of any member grant.
    // service mailboxes are key-driven, never user-facing — keep them out.
    // Hide mailboxes being hard-deleted; empty-pending ones stay (shown empty).
    const rows = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        expiresAt: mailbox.expiresAt,
        domainName: domain.name,
        pgpMode: mailbox.pgpMode,
        aiFeatures: mailbox.aiFeatures,
        ownerUserId: mailbox.ownerUserId,
        perms: mailboxMember.perms,
      })
      .from(mailbox)
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .leftJoin(
        mailboxMember,
        and(eq(mailboxMember.mailboxId, mailbox.id), eq(mailboxMember.userId, u.id)),
      )
      .where(
        and(
          or(eq(mailbox.ownerUserId, u.id), eq(mailboxMember.userId, u.id)),
          ne(mailbox.type, "service"),
          mailboxNotDeletePending,
        ),
      );

    const all = rows.map((m) => {
      const isOwner = m.ownerUserId === u.id;
      return {
        id: m.id,
        address: `${m.localPart}@${m.domainName}`,
        displayName: m.displayName,
        type: m.type,
        expiresAt: m.expiresAt,
        pgpMode: m.pgpMode,
        aiFeatures: m.aiFeatures,
        role: isOwner ? ("owner" as const) : ("member" as const),
        perms: isOwner ? 7 : (m.perms ?? 0),
      };
    });

    // Unread badge per mailbox: active (non-trash/spam) threads with unread
    // inbound mail. `unreadCount > 0` already implies an unseen inbound message.
    // Threads the user filed into a custom folder are "moved away" and excluded.
    const ids = all.map((m) => m.id);
    const unreadRows = ids.length
      ? await db
          .select({ mailboxId: thread.mailboxId, c: count() })
          .from(thread)
          // Join the mailbox so an empty-pending one reads as zero unread at once.
          .innerJoin(mailbox, eq(thread.mailboxId, mailbox.id))
          .where(
            and(
              inArray(thread.mailboxId, ids),
              mailboxNotPurging,
              eq(thread.trashed, false),
              eq(thread.spam, false),
              gt(thread.unreadCount, 0),
              sql`not exists (select 1 from ${threadFolder} where ${threadFolder.threadId} = ${thread.id} and ${threadFolder.userId} = ${u.id})`,
            ),
          )
          .groupBy(thread.mailboxId)
      : [];
    const unreadMap = new Map(unreadRows.map((row) => [row.mailboxId, row.c]));

    return c.json({
      mailboxes: all.map((m) => ({
        ...m,
        expiresAt: m.expiresAt?.toISOString() ?? null,
        unread: unreadMap.get(m.id) ?? 0,
      })),
    } satisfies MailboxListDto);
  });

  r.post("/", zValidator("json", createMailbox), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const body = c.req.valid("json");

    if (body.type === "service") {
      throw new HTTPException(400, { message: "service mailboxes are created from Admin" });
    }
    await authorizeMailboxCreate(db, u, body.domainId, body.type);

    const id = crypto.randomUUID();
    const expiresAt = body.ttlSeconds ? new Date(Date.now() + body.ttlSeconds * 1000) : null;

    await db.insert(mailbox).values({
      id,
      domainId: body.domainId,
      localPart: body.localPart.toLowerCase(),
      displayName: body.displayName ?? null,
      type: body.type,
      ownerUserId: u.id,
      signature: body.signature ?? null,
      replyTo: body.replyTo ?? null,
      expiresAt,
    });

    return c.json({ id }, 201);
  });

  r.get("/:id/settings", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.READ);
    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: {
        id: true,
        displayName: true,
        signature: true,
        replyTo: true,
        type: true,
        spamFilter: true,
        spamAiTokenCap: true,
        aiFeatures: true,
        aiTokenCap: true,
        pgpMode: true,
        pgpFingerprint: true,
        pgpPublicKey: true,
      },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    const [usage, aiUsage] = await Promise.all([
      db.query.mailboxSpamUsage.findFirst({
        where: eq(mailboxSpamUsage.mailboxId, id),
        columns: { period: true, calls: true, tokensIn: true, tokensOut: true },
      }),
      db.query.mailboxAiUsage.findFirst({
        where: eq(mailboxAiUsage.mailboxId, id),
        columns: { period: true, calls: true, tokensIn: true, tokensOut: true },
      }),
    ]);
    return c.json({
      id: mb.id,
      type: mb.type,
      displayName: mb.displayName,
      signature: mb.signature,
      replyTo: mb.replyTo,
      spamFilter: mb.spamFilter,
      spamAiTokenCap: mb.spamAiTokenCap,
      spamUsage: usage
        ? {
            period: usage.period,
            calls: usage.calls,
            tokens: usage.tokensIn + usage.tokensOut,
          }
        : null,
      aiFeatures: mb.aiFeatures,
      aiTokenCap: mb.aiTokenCap,
      aiUsage: aiUsage
        ? {
            period: aiUsage.period,
            calls: aiUsage.calls,
            tokens: aiUsage.tokensIn + aiUsage.tokensOut,
          }
        : null,
      pgpMode: mb.pgpMode,
      pgpFingerprint: mb.pgpFingerprint,
      pgpPublicKey: mb.pgpPublicKey,
      pgpConfigured: Boolean(mb.pgpPublicKey),
    } satisfies MailboxSettingsDto);
  });

  r.patch("/:id/settings", zValidator("json", updateMailboxSettings), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);

    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { type: true, pgpPublicKey: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.type === "temp") {
      throw new HTTPException(400, { message: "temp mailboxes are not editable" });
    }

    // Spam filter level + AI budget are admin-only (see /api/admin/mailboxes/:id/settings);
    // owners can edit identity fields but not the spam policy applied to their mailbox.
    const patch: Partial<{
      displayName: string | null;
      signature: string | null;
      replyTo: string | null;
      pgpMode: PgpMode;
    }> = {};
    if (body.displayName !== undefined) {
      patch.displayName = body.displayName?.trim() ? body.displayName.trim() : null;
    }
    if (body.signature !== undefined) {
      patch.signature = body.signature?.trim() ? body.signature : null;
    }
    if (body.replyTo !== undefined) {
      patch.replyTo = body.replyTo ? body.replyTo : null;
    }
    if (body.pgpMode !== undefined) {
      // Can't sign/encrypt without a keypair — make the owner add one first.
      if (body.pgpMode !== "off" && !mb.pgpPublicKey) {
        throw new HTTPException(400, { message: "generate or import a PGP key first" });
      }
      patch.pgpMode = body.pgpMode;
    }
    if (Object.keys(patch).length === 0) return c.json({ ok: true });

    await db.update(mailbox).set(patch).where(eq(mailbox.id, id));
    return c.json({ ok: true });
  });

  // ─── Gateway PGP key management (owner, Perm.MANAGE) ──────────────────────

  // Generate a fresh keypair for the mailbox. Returns the fingerprint + public
  // key once; the private key never leaves the server (wrapped at rest).
  r.post("/:id/pgp/generate", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    const mb = await loadPgpTarget(db, id);
    const addr = `${mb.localPart}@${mb.domainName}`;
    const km = await generateKeypair(mb.displayName ?? addr, addr);
    await storeKeypair(db, id, km);
    return c.json({
      fingerprint: km.fingerprint,
      publicKey: km.publicArmored,
    } satisfies PgpKeyResultDto);
  });

  // Import an existing armored private key. Re-wrapped under our own passphrase.
  r.post("/:id/pgp/import", zValidator("json", importPgpKey), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await loadPgpTarget(db, id);
    let km: Awaited<ReturnType<typeof importPrivateKey>>;
    try {
      km = await importPrivateKey(body.privateKey, body.passphrase);
    } catch (err) {
      throw new HTTPException(400, {
        message: err instanceof Error ? err.message : "invalid private key",
      });
    }
    await storeKeypair(db, id, km);
    return c.json({
      fingerprint: km.fingerprint,
      publicKey: km.publicArmored,
    } satisfies PgpKeyResultDto);
  });

  // Remove the keypair and disable PGP.
  r.delete("/:id/pgp", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .update(mailbox)
      .set({
        pgpMode: "off",
        pgpPublicKey: null,
        pgpPrivateKeyWrapped: null,
        pgpPassphraseWrapped: null,
        pgpFingerprint: null,
      })
      .where(eq(mailbox.id, id));
    return c.json({ ok: true });
  });

  // ─── Contact (correspondent) public keys ──────────────────────────────────

  r.get("/:id/contacts", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.READ);
    const rows = await db.query.contactKey.findMany({
      where: eq(contactKey.mailboxId, id),
      columns: { id: true, email: true, fingerprint: true, source: true, createdAt: true },
    });
    return c.json({
      keys: rows.map((row) => ({
        id: row.id,
        email: row.email,
        fingerprint: row.fingerprint,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
      })),
    } satisfies ContactKeysDto);
  });

  r.post("/:id/contacts", zValidator("json", addContactKey), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    let info: Awaited<ReturnType<typeof readPublicKeyInfo>>;
    try {
      info = await readPublicKeyInfo(body.publicKey);
    } catch (err) {
      throw new HTTPException(400, {
        message: err instanceof Error ? err.message : "invalid public key",
      });
    }
    const email = (body.email ?? info.emails[0])?.toLowerCase();
    if (!email) throw new HTTPException(400, { message: "no email in key; provide one" });
    await db
      .insert(contactKey)
      .values({
        id: crypto.randomUUID(),
        mailboxId: id,
        email,
        publicKey: info.publicArmored,
        fingerprint: info.fingerprint,
        source: "import",
      })
      .onConflictDoUpdate({
        target: [contactKey.mailboxId, contactKey.email],
        set: { publicKey: info.publicArmored, fingerprint: info.fingerprint, source: "import" },
      });
    return c.json({ ok: true }, 201);
  });

  r.delete("/:id/contacts/:contactId", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const contactId = c.req.param("contactId");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .delete(contactKey)
      .where(and(eq(contactKey.id, contactId), eq(contactKey.mailboxId, id)));
    return c.json({ ok: true });
  });

  // Import a single exported message (raw .eml bytes). The browser extracts
  // .eml/.mbox/.zip client-side and POSTs one message per request, which keeps
  // each call within Worker CPU/memory/body limits regardless of archive size.
  r.post("/:id/import", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.WRITE);

    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { id: true, localPart: true, domainId: true, type: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.type === "service") {
      throw new HTTPException(400, { message: "cannot import into a service mailbox" });
    }

    const raw = await c.req.raw.arrayBuffer();
    if (!raw.byteLength) throw new HTTPException(400, { message: "empty" });
    if (raw.byteLength > MAX_EMAIL_BYTES) throw new HTTPException(413, { message: "too large" });

    const parsed = await parseMime(raw);

    // Skip content-free fragments. An mbox split can emit stray separators or
    // truncated tails that parse into a message with no subject, no body, and no
    // attachments — importing those just litters the mailbox with blank rows.
    const isEmpty =
      !parsed.subject?.trim() &&
      !bodyForIndex(parsed.text, parsed.html).trim() &&
      !(parsed.attachments?.length ?? 0);
    if (isEmpty) return c.json({ skipped: true });

    // Dedup by Message-ID within this mailbox so re-importing is idempotent.
    if (parsed.messageId) {
      const dup = await db.query.message.findFirst({
        where: and(eq(message.mailboxId, id), eq(message.messageIdHdr, parsed.messageId)),
        columns: { id: true },
      });
      if (dup) return c.json({ duplicate: true });
    }

    const dom = await db.query.domain.findFirst({
      where: eq(domain.id, mb.domainId),
      columns: { name: true },
    });
    const ownAddr = dom ? `${mb.localPart}@${dom.name}`.toLowerCase() : "";
    const fromAddr = (parsed.from?.address ?? "").trim().toLowerCase();
    // Mail this mailbox sent is filed as outbound; everything else is inbound.
    const direction = fromAddr && fromAddr === ownAddr ? "out" : "in";

    const parsedDate = parsed.date ? new Date(parsed.date) : null;
    const when = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date();

    // Optional per-message state hints (e.g. a Proton export carries read/star
    // and folder placement in sidecar metadata). Absent for plain .eml/.mbox,
    // where mail defaults to read so it doesn't inflate badges.
    const seen = c.req.query("seen") !== "0";
    const starred = c.req.query("starred") === "1";
    const wantTrash = c.req.query("trashed") === "1";
    const wantSpam = c.req.query("spam") === "1" && !wantTrash;

    let flags = direction === "out" ? Flag.SENT : 0;
    if (seen) flags |= Flag.SEEN;
    if (starred) flags |= Flag.STARRED;

    const result = await ingestRaw(c.env, db, {
      mailboxId: id,
      raw,
      parsed,
      direction,
      deliveredTo: direction === "in" ? ownAddr || null : null,
      flags,
      receivedAt: direction === "in" ? when : null,
      sentAt: direction === "out" ? when : null,
      spam: null,
    });

    // Trash and spam are thread-level, mutually-exclusive buckets (see threads.ts).
    if (wantTrash || wantSpam) {
      await db
        .update(thread)
        .set({ trashed: wantTrash, trashedAt: wantTrash ? when : null, spam: wantSpam })
        .where(eq(thread.id, result.threadId));
    }

    return c.json({ messageId: result.messageId, threadId: result.threadId, duplicate: false });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { ownerUserId: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.ownerUserId !== u.id) throw new HTTPException(403, { message: "owner only" });
    const keys = await collectMailboxBlobKeys(db, id);
    await deleteBlobs(c.env, keys);
    await db.delete(mailbox).where(eq(mailbox.id, id));
    return c.body(null, 204);
  });

  r.get("/:id/members", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    const rows = await db
      .select({
        userId: mailboxMember.userId,
        perms: mailboxMember.perms,
        email: user.email,
        name: user.name,
      })
      .from(mailboxMember)
      .innerJoin(user, eq(user.id, mailboxMember.userId))
      .where(eq(mailboxMember.mailboxId, id));
    return c.json({ members: rows } satisfies MailboxMembersDto);
  });

  r.post("/:id/members", zValidator("json", grantMember), async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requirePerm(db, u.id, id, Perm.MANAGE);

    let perms = 0;
    if (body.read) perms = grant(perms, Perm.READ);
    if (body.write) perms = grant(perms, Perm.WRITE);
    if (body.manage) perms = grant(perms, Perm.MANAGE);

    const found = await db.query.user.findFirst({
      where: eq(user.id, body.userId),
      columns: { id: true },
    });
    if (!found) throw new HTTPException(404, { message: "user not found" });

    await db
      .insert(mailboxMember)
      .values({ mailboxId: id, userId: found.id, perms })
      .onConflictDoUpdate({
        target: [mailboxMember.mailboxId, mailboxMember.userId],
        set: { perms },
      });
    return c.json({ ok: true, userId: found.id });
  });

  r.get("/:id/invites", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    const rows = await db
      .select({
        id: mailboxInvite.id,
        email: mailboxInvite.email,
        perms: mailboxInvite.perms,
        createdAt: mailboxInvite.createdAt,
      })
      .from(mailboxInvite)
      .where(eq(mailboxInvite.mailboxId, id));
    return c.json({
      invites: rows.map((inv) => ({ ...inv, createdAt: inv.createdAt.toISOString() })),
    } satisfies MailboxInvitesDto);
  });

  r.delete("/:id/invites/:inviteId", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const inviteId = c.req.param("inviteId");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .delete(mailboxInvite)
      .where(and(eq(mailboxInvite.id, inviteId), eq(mailboxInvite.mailboxId, id)));
    return c.body(null, 204);
  });

  r.delete("/:id/members/:userId", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;
    const id = c.req.param("id");
    const uid = c.req.param("userId");
    await requirePerm(db, u.id, id, Perm.MANAGE);
    await db
      .delete(mailboxMember)
      .where(and(eq(mailboxMember.mailboxId, id), eq(mailboxMember.userId, uid)));
    return c.body(null, 204);
  });

  // Suppress unused-import warning from tree-shaking of `or`.
  void or;
  return r;
}

// Load a mailbox for PGP key ops and resolve its full address. Rejects temp
// mailboxes (no durable identity to bind a key to).
async function loadPgpTarget(db: DB, id: string) {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, id),
    columns: { id: true, localPart: true, domainId: true, displayName: true, type: true },
  });
  if (!mb) throw new HTTPException(404, { message: "not found" });
  if (mb.type === "temp") throw new HTTPException(400, { message: "temp mailboxes can't use PGP" });
  const dom = await db.query.domain.findFirst({
    where: eq(domain.id, mb.domainId),
    columns: { name: true },
  });
  if (!dom) throw new HTTPException(500, { message: "domain missing" });
  return { ...mb, domainName: dom.name };
}

// Wrap the private key + passphrase under the master key and persist. The public
// key + fingerprint are stored in the clear (they're public).
async function storeKeypair(db: DB, id: string, km: MailboxKeyMaterial): Promise<void> {
  const masterKey = await getOrCreatePgpMasterKey(db);
  const [privateKeyWrapped, passphraseWrapped] = await Promise.all([
    wrapSecret(masterKey, km.privateArmored),
    wrapSecret(masterKey, km.passphrase),
  ]);
  await db
    .update(mailbox)
    .set({
      pgpPublicKey: km.publicArmored,
      pgpPrivateKeyWrapped: privateKeyWrapped,
      pgpPassphraseWrapped: passphraseWrapped,
      pgpFingerprint: km.fingerprint,
    })
    .where(eq(mailbox.id, id));
}
