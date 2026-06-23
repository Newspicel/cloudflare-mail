import {
  domain,
  mailbox,
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
  MailboxInvitesDto,
  MailboxListDto,
  MailboxMembersDto,
  MailboxSettingsDto,
} from "@cfmail/shared/responses";
import { createMailbox, grantMember, updateMailboxSettings } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { ingestRaw, MAX_EMAIL_BYTES } from "../mail/ingest.ts";
import { parseMime } from "../mail/mime.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

export function mailboxesRoutes() {
  const r = new Hono<AppBindings>();

  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;

    const ownerRows = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        expiresAt: mailbox.expiresAt,
        domainName: domain.name,
        access: mailbox.ownerUserId,
      })
      .from(mailbox)
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      // service mailboxes are key-driven, never user-facing — keep them out.
      .where(and(eq(mailbox.ownerUserId, u.id), ne(mailbox.type, "service")));

    const memberRows = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        expiresAt: mailbox.expiresAt,
        domainName: domain.name,
        perms: mailboxMember.perms,
      })
      .from(mailboxMember)
      .innerJoin(mailbox, eq(mailboxMember.mailboxId, mailbox.id))
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .where(and(eq(mailboxMember.userId, u.id), ne(mailbox.type, "service")));

    const owned = ownerRows.map((m) => ({
      id: m.id,
      address: `${m.localPart}@${m.domainName}`,
      displayName: m.displayName,
      type: m.type,
      expiresAt: m.expiresAt,
      role: "owner" as const,
      perms: 7,
    }));
    const ownedIds = new Set(ownerRows.map((m) => m.id));
    const shared = memberRows
      .filter((m) => !ownedIds.has(m.id))
      .map((m) => ({
        id: m.id,
        address: `${m.localPart}@${m.domainName}`,
        displayName: m.displayName,
        type: m.type,
        expiresAt: m.expiresAt,
        role: "member" as const,
        perms: m.perms,
      }));

    // Unread badge per mailbox: active (non-trash/spam) threads with unread
    // inbound mail. `unreadCount > 0` already implies an unseen inbound message.
    // Threads the user filed into a custom folder are "moved away" and excluded.
    const all = [...owned, ...shared];
    const ids = all.map((m) => m.id);
    const unreadRows = ids.length
      ? await db
          .select({ mailboxId: thread.mailboxId, c: count() })
          .from(thread)
          .where(
            and(
              inArray(thread.mailboxId, ids),
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
      },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    const usage = await db.query.mailboxSpamUsage.findFirst({
      where: eq(mailboxSpamUsage.mailboxId, id),
      columns: { period: true, calls: true, tokensIn: true, tokensOut: true },
    });
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
      columns: { type: true },
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
    if (Object.keys(patch).length === 0) return c.json({ ok: true });

    await db.update(mailbox).set(patch).where(eq(mailbox.id, id));
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

    const result = await ingestRaw(c.env, db, {
      mailboxId: id,
      raw,
      parsed,
      direction,
      deliveredTo: direction === "in" ? ownAddr || null : null,
      // Imported historical mail is marked read so it doesn't inflate badges.
      flags: direction === "out" ? Flag.SENT | Flag.SEEN : Flag.SEEN,
      receivedAt: direction === "in" ? when : null,
      sentAt: direction === "out" ? when : null,
      spam: null,
    });

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
