import { domain, mailbox, redirect, user } from "@cfmail/db/schema";
import {
  adminCreateMailbox,
  adminDeleteMailbox,
  createRedirect,
  migrateMailbox,
} from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { aliasedTable, and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { collectMailboxBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
import { requireAdmin, requireUser } from "../middleware.ts";

// Admin-only mailbox & redirect management. Mounted at /api/admin.
export function adminRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser, requireAdmin);

  // ─── Mailboxes ────────────────────────────────────────────────────────────

  r.get("/mailboxes", async (c) => {
    const db = dbFromCtx(c);
    const rows = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        displayName: mailbox.displayName,
        type: mailbox.type,
        domainName: domain.name,
        expiresAt: mailbox.expiresAt,
        createdAt: mailbox.createdAt,
        ownerUserId: mailbox.ownerUserId,
        ownerEmail: user.email,
        ownerName: user.name,
      })
      .from(mailbox)
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .innerJoin(user, eq(mailbox.ownerUserId, user.id))
      .orderBy(asc(domain.name), asc(mailbox.localPart));
    return c.json({
      mailboxes: rows.map((m) => ({
        id: m.id,
        address: `${m.localPart}@${m.domainName}`,
        displayName: m.displayName,
        type: m.type,
        expiresAt: m.expiresAt,
        createdAt: m.createdAt,
        ownerUserId: m.ownerUserId,
        ownerEmail: m.ownerEmail,
        ownerName: m.ownerName,
      })),
    });
  });

  r.post("/mailboxes", zValidator("json", adminCreateMailbox), async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const body = c.req.valid("json");
    if (body.type === "temp") {
      throw new HTTPException(400, { message: "temp mailboxes are created via /api/temp" });
    }

    const owner = await db.query.user.findFirst({
      where: eq(user.id, body.ownerUserId),
      columns: { id: true },
    });
    if (!owner) throw new HTTPException(400, { message: "owner not found" });

    // Admin bypasses the per-user grant; domain.allowedKinds is still enforced.
    await authorizeMailboxCreate(db, me, body.domainId, body.type);

    const id = crypto.randomUUID();
    try {
      await db.insert(mailbox).values({
        id,
        domainId: body.domainId,
        localPart: body.localPart.toLowerCase(),
        displayName: body.displayName ?? null,
        type: body.type,
        ownerUserId: body.ownerUserId,
      });
    } catch {
      throw new HTTPException(409, { message: "address already in use" });
    }
    return c.json({ id }, 201);
  });

  r.patch("/mailboxes/:id", zValidator("json", migrateMailbox), async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { id: true, type: true, ownerUserId: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });
    if (mb.type === "temp")
      throw new HTTPException(400, { message: "temp mailboxes cannot be migrated" });

    const owner = await db.query.user.findFirst({
      where: eq(user.id, body.ownerUserId),
      columns: { id: true },
    });
    if (!owner) throw new HTTPException(400, { message: "owner not found" });
    if (owner.id === mb.ownerUserId) return c.json({ ok: true });

    await db.update(mailbox).set({ ownerUserId: body.ownerUserId }).where(eq(mailbox.id, id));
    return c.json({ ok: true });
  });

  r.delete("/mailboxes/:id", zValidator("json", adminDeleteMailbox), async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const mb = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, id),
      columns: { id: true, domainId: true, localPart: true },
    });
    if (!mb) throw new HTTPException(404, { message: "not found" });

    let target: { id: string; type: string } | undefined;
    if (body.redirectToMailboxId) {
      if (body.redirectToMailboxId === id) {
        throw new HTTPException(400, { message: "cannot redirect a mailbox to itself" });
      }
      target = await db.query.mailbox.findFirst({
        where: eq(mailbox.id, body.redirectToMailboxId),
        columns: { id: true, type: true },
      });
      if (!target) throw new HTTPException(400, { message: "redirect target not found" });
      if (target.type === "service") {
        throw new HTTPException(400, { message: "service mailboxes cannot receive mail" });
      }
    }

    const keys = await collectMailboxBlobKeys(db, id);
    await deleteBlobs(c.env, keys);
    // Deleting frees the (domain, local_part) address before the redirect claims it.
    await db.delete(mailbox).where(eq(mailbox.id, id));

    if (target) {
      await db.insert(redirect).values({
        id: crypto.randomUUID(),
        domainId: mb.domainId,
        localPart: mb.localPart,
        targetMailboxId: target.id,
      });
    }
    return c.body(null, 204);
  });

  // ─── Redirects ────────────────────────────────────────────────────────────

  r.get("/redirects", async (c) => {
    const db = dbFromCtx(c);
    const targetMb = aliasedTable(mailbox, "target_mb");
    const targetDom = aliasedTable(domain, "target_dom");
    const rows = await db
      .select({
        id: redirect.id,
        localPart: redirect.localPart,
        domainName: domain.name,
        createdAt: redirect.createdAt,
        targetMailboxId: redirect.targetMailboxId,
        targetLocalPart: targetMb.localPart,
        targetDomainName: targetDom.name,
      })
      .from(redirect)
      .innerJoin(domain, eq(redirect.domainId, domain.id))
      .innerJoin(targetMb, eq(redirect.targetMailboxId, targetMb.id))
      .innerJoin(targetDom, eq(targetMb.domainId, targetDom.id))
      .orderBy(desc(redirect.createdAt));
    return c.json({
      redirects: rows.map((row) => ({
        id: row.id,
        address: `${row.localPart}@${row.domainName}`,
        targetMailboxId: row.targetMailboxId,
        targetAddress: `${row.targetLocalPart}@${row.targetDomainName}`,
        createdAt: row.createdAt,
      })),
    });
  });

  r.post("/redirects", zValidator("json", createRedirect), async (c) => {
    const db = dbFromCtx(c);
    const body = c.req.valid("json");
    const localPart = body.localPart.toLowerCase();

    const target = await db.query.mailbox.findFirst({
      where: eq(mailbox.id, body.targetMailboxId),
      columns: { id: true, type: true },
    });
    if (!target) throw new HTTPException(400, { message: "redirect target not found" });
    if (target.type === "service") {
      throw new HTTPException(400, { message: "service mailboxes cannot receive mail" });
    }

    // A real mailbox at this address always wins in receive.ts — refuse to
    // create a redirect that can never fire.
    const clash = await db.query.mailbox.findFirst({
      where: and(eq(mailbox.domainId, body.domainId), eq(mailbox.localPart, localPart)),
      columns: { id: true },
    });
    if (clash) throw new HTTPException(409, { message: "a mailbox already owns this address" });

    const id = crypto.randomUUID();
    await db
      .insert(redirect)
      .values({ id, domainId: body.domainId, localPart, targetMailboxId: body.targetMailboxId })
      .onConflictDoUpdate({
        target: [redirect.domainId, redirect.localPart],
        set: { targetMailboxId: body.targetMailboxId },
      });
    return c.json({ ok: true }, 201);
  });

  r.delete("/redirects/:id", async (c) => {
    const db = dbFromCtx(c);
    const id = c.req.param("id");
    const res = await db.delete(redirect).where(eq(redirect.id, id));
    if (!res.success) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  return r;
}
