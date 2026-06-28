import { blocklist, blockRequest, user } from "@cfmail/db/schema";
import { createBlockEntry, setProtectedDomains } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { aliasedTable, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import {
  getProtectedDomains,
  isProtectedDomain,
  setProtectedDomains as persistProtectedDomains,
} from "../mail/blocklist.ts";
import { requireAdmin, requireUser } from "../middleware.ts";
import { wrapUnique } from "./util.ts";

// Admin-only blocklist + block-request review. Mounted at /api/admin/block.
export function adminBlockRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser, requireAdmin);

  // ─── Blocklist entries ──────────────────────────────────────────────────────

  r.get("/entries", async (c) => {
    const db = dbFromCtx(c);
    const rows = await db
      .select({
        id: blocklist.id,
        type: blocklist.type,
        value: blocklist.value,
        reason: blocklist.reason,
        createdAt: blocklist.createdAt,
        createdByName: user.name,
      })
      .from(blocklist)
      .leftJoin(user, eq(blocklist.createdByUserId, user.id))
      .orderBy(desc(blocklist.createdAt));
    return c.json({ entries: rows });
  });

  r.post("/entries", zValidator("json", createBlockEntry), async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const body = c.req.valid("json");
    const value = body.value.trim().toLowerCase();

    if (body.type === "domain" && (await isProtectedDomain(db, value))) {
      throw new HTTPException(400, {
        message: "this domain is protected — block individual addresses instead",
      });
    }

    const id = crypto.randomUUID();
    await wrapUnique(
      () =>
        db.insert(blocklist).values({
          id,
          type: body.type,
          value,
          reason: body.reason?.trim() || null,
          createdByUserId: me.id,
        }),
      "already on the blocklist",
    );
    return c.json({ id }, 201);
  });

  r.delete("/entries/:id", async (c) => {
    const db = dbFromCtx(c);
    const res = await db.delete(blocklist).where(eq(blocklist.id, c.req.param("id")));
    if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  // ─── Block requests ──────────────────────────────────────────────────────────

  r.get("/requests", async (c) => {
    const db = dbFromCtx(c);
    const requester = aliasedTable(user, "requester");
    const rows = await db
      .select({
        id: blockRequest.id,
        type: blockRequest.type,
        value: blockRequest.value,
        fromName: blockRequest.fromName,
        subject: blockRequest.subject,
        note: blockRequest.note,
        status: blockRequest.status,
        createdAt: blockRequest.createdAt,
        reviewedAt: blockRequest.reviewedAt,
        requestedByName: requester.name,
        requestedByEmail: requester.email,
      })
      .from(blockRequest)
      .leftJoin(requester, eq(blockRequest.requestedByUserId, requester.id))
      // Newest first; the client groups pending ahead of reviewed for display.
      .orderBy(desc(blockRequest.createdAt));
    return c.json({ requests: rows });
  });

  r.post("/requests/:id/approve", async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const req = await db.query.blockRequest.findFirst({
      where: eq(blockRequest.id, c.req.param("id")),
    });
    if (!req) throw new HTTPException(404, { message: "not found" });
    if (req.status !== "pending") throw new HTTPException(409, { message: "already reviewed" });

    const value = req.value.trim().toLowerCase();
    if (req.type === "domain" && (await isProtectedDomain(db, value))) {
      throw new HTTPException(400, { message: "this domain is protected" });
    }

    // Promote into the blocklist (idempotent if it's already there).
    await db
      .insert(blocklist)
      .values({
        id: crypto.randomUUID(),
        type: req.type,
        value,
        reason: req.note?.trim() || "approved block request",
        createdByUserId: me.id,
      })
      .onConflictDoNothing();
    await db
      .update(blockRequest)
      .set({ status: "approved", reviewedByUserId: me.id, reviewedAt: new Date() })
      .where(eq(blockRequest.id, req.id));
    return c.json({ ok: true });
  });

  r.post("/requests/:id/deny", async (c) => {
    const db = dbFromCtx(c);
    const me = c.get("user")!;
    const res = await db
      .update(blockRequest)
      .set({ status: "denied", reviewedByUserId: me.id, reviewedAt: new Date() })
      .where(eq(blockRequest.id, c.req.param("id")));
    if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  });

  r.delete("/requests/:id", async (c) => {
    const db = dbFromCtx(c);
    const res = await db.delete(blockRequest).where(eq(blockRequest.id, c.req.param("id")));
    if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

  // ─── Protected-domains whitelist ─────────────────────────────────────────────

  r.get("/protected-domains", async (c) => {
    const db = dbFromCtx(c);
    return c.json({ domains: await getProtectedDomains(db) });
  });

  r.put("/protected-domains", zValidator("json", setProtectedDomains), async (c) => {
    const db = dbFromCtx(c);
    await persistProtectedDomains(db, c.req.valid("json").domains);
    return c.json({ domains: await getProtectedDomains(db) });
  });

  return r;
}
