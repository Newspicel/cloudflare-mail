import { attachment, domain, mailbox, message } from "@cfmail/db/schema";
import { serviceSend } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { parseMime } from "../mail/mime.ts";
import { sendFromMailbox } from "../mail/send.ts";

const PAGE_SIZE = 50;

// SHA-256 hex of a string — used to look up a service mailbox by its bearer key
// without storing the key itself.
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Resolves `Authorization: Bearer <key>` to a service mailbox. No session.
const serviceKeyAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  if (!token) throw new HTTPException(401, { message: "missing bearer key" });
  const db = dbFromCtx(c);
  const hash = await sha256Hex(token);
  const mb = await db.query.mailbox.findFirst({
    where: and(eq(mailbox.serviceKeyHash, hash), eq(mailbox.type, "service")),
    columns: { id: true, domainId: true, localPart: true, serviceMode: true },
  });
  if (!mb) throw new HTTPException(401, { message: "invalid key" });
  c.set("serviceMailbox", {
    id: mb.id,
    domainId: mb.domainId,
    localPart: mb.localPart,
    mode: mb.serviceMode,
  });
  return next();
};

// Key-driven send/receive for service mailboxes. Mounted at /api/svc, outside
// session middleware. The mailbox is whatever the bearer key unlocks.
export function svcRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", serviceKeyAuth);

  r.get("/info", async (c) => {
    const db = dbFromCtx(c);
    const mb = c.get("serviceMailbox")!;
    const dom = await db.query.domain.findFirst({
      where: eq(domain.id, mb.domainId),
      columns: { name: true },
    });
    return c.json({
      address: `${mb.localPart}@${dom?.name ?? ""}`,
      mode: mb.mode,
    });
  });

  r.post("/send", zValidator("json", serviceSend), async (c) => {
    const db = dbFromCtx(c);
    const mb = c.get("serviceMailbox")!;
    const body = c.req.valid("json");
    const result = await sendFromMailbox(c.env, db, null, { ...body, mailboxId: mb.id });
    return c.json(result, 201);
  });

  // Poll messages, newest first. Without `after`, returns the newest page.
  // With `after=<id>`, returns the next page of messages strictly newer than
  // that id (oldest-first) so a client can drain without gaps; advance the
  // cursor to `nextCursor` each round.
  r.get("/messages", zValidator("query", z.object({ after: z.string().optional() })), async (c) => {
    const db = dbFromCtx(c);
    const mb = c.get("serviceMailbox")!;
    const { after } = c.req.valid("query");

    let cursor: { createdAt: Date; id: string } | null = null;
    if (after) {
      const cur = await db.query.message.findFirst({
        where: and(eq(message.id, after), eq(message.mailboxId, mb.id)),
        columns: { createdAt: true, id: true },
      });
      if (!cur) throw new HTTPException(400, { message: "unknown cursor" });
      cursor = cur;
    }

    const where = cursor
      ? and(
          eq(message.mailboxId, mb.id),
          or(
            gt(message.createdAt, cursor.createdAt),
            and(eq(message.createdAt, cursor.createdAt), gt(message.id, cursor.id)),
          ),
        )
      : eq(message.mailboxId, mb.id);

    const rows = await db
      .select({
        id: message.id,
        direction: message.direction,
        fromName: message.fromName,
        fromAddr: message.fromAddr,
        toAddrs: message.toAddrs,
        ccAddrs: message.ccAddrs,
        subject: message.subject,
        snippet: message.snippet,
        receivedAt: message.receivedAt,
        sentAt: message.sentAt,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(where)
      .orderBy(
        cursor ? asc(message.createdAt) : desc(message.createdAt),
        cursor ? asc(message.id) : desc(message.id),
      )
      .limit(PAGE_SIZE);

    // Newest id in this batch — the cursor to poll with next time.
    const newest = rows.reduce<(typeof rows)[number] | null>(
      (acc, row) => (!acc || row.createdAt > acc.createdAt ? row : acc),
      null,
    );

    return c.json({
      messages: rows.map((m) => ({
        id: m.id,
        direction: m.direction,
        from: { name: m.fromName ?? undefined, address: m.fromAddr },
        to: m.toAddrs,
        cc: m.ccAddrs ?? [],
        subject: m.subject,
        snippet: m.snippet,
        receivedAt: m.receivedAt,
        sentAt: m.sentAt,
        createdAt: m.createdAt,
      })),
      nextCursor: newest?.id ?? after ?? null,
    });
  });

  r.get("/messages/:id", async (c) => {
    const db = dbFromCtx(c);
    const mb = c.get("serviceMailbox")!;
    const id = c.req.param("id");
    const msg = await db.query.message.findFirst({
      where: and(eq(message.id, id), eq(message.mailboxId, mb.id)),
      columns: {
        id: true,
        direction: true,
        fromName: true,
        fromAddr: true,
        toAddrs: true,
        ccAddrs: true,
        subject: true,
        receivedAt: true,
        sentAt: true,
        createdAt: true,
        rawR2Key: true,
      },
    });
    if (!msg) throw new HTTPException(404, { message: "not found" });

    let text: string | undefined;
    let html: string | undefined;
    if (msg.rawR2Key) {
      const obj = await c.env.BLOBS.get(msg.rawR2Key);
      if (obj) {
        const parsed = await parseMime(await obj.arrayBuffer());
        text = parsed.text ?? undefined;
        html = parsed.html ?? undefined;
      }
    }

    const atts = await db
      .select({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      })
      .from(attachment)
      .where(eq(attachment.messageId, id));

    return c.json({
      id: msg.id,
      direction: msg.direction,
      from: { name: msg.fromName ?? undefined, address: msg.fromAddr },
      to: msg.toAddrs,
      cc: msg.ccAddrs ?? [],
      subject: msg.subject,
      text,
      html,
      receivedAt: msg.receivedAt,
      sentAt: msg.sentAt,
      createdAt: msg.createdAt,
      attachments: atts,
    });
  });

  return r;
}
