import { domain, mailbox, mailboxMember } from "@cfmail/db/schema";
import { has, Perm } from "@cfmail/shared/permissions";
import type { SearchResultsDto } from "@cfmail/shared/responses";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export function searchRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const rawQ = c.req.query("q") ?? "";
    const matchExpr = toFtsMatch(rawQ);
    if (!matchExpr) return c.json({ results: [] } satisfies SearchResultsDto);

    const limit = Math.min(Number(c.req.query("limit") ?? DEFAULT_LIMIT), MAX_LIMIT);
    const mailboxFilter = c.req.query("mailboxId")?.trim() || null;

    const owned = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        domainName: domain.name,
      })
      .from(mailbox)
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .where(eq(mailbox.ownerUserId, user.id));

    const shared = await db
      .select({
        id: mailbox.id,
        localPart: mailbox.localPart,
        domainName: domain.name,
        perms: mailboxMember.perms,
      })
      .from(mailboxMember)
      .innerJoin(mailbox, eq(mailboxMember.mailboxId, mailbox.id))
      .innerJoin(domain, eq(mailbox.domainId, domain.id))
      .where(eq(mailboxMember.userId, user.id));

    const addressById = new Map<string, string>();
    for (const m of owned) addressById.set(m.id, `${m.localPart}@${m.domainName}`);
    for (const m of shared) {
      if (has(m.perms, Perm.READ)) addressById.set(m.id, `${m.localPart}@${m.domainName}`);
    }

    if (mailboxFilter) {
      const addr = addressById.get(mailboxFilter);
      if (!addr) throw new HTTPException(403, { message: "forbidden" });
      addressById.clear();
      addressById.set(mailboxFilter, addr);
    }
    if (addressById.size === 0) return c.json({ results: [] } satisfies SearchResultsDto);

    const ids = [...addressById.keys()];
    const placeholders = ids.map(() => "?").join(",");
    const stmt = c.env.DB.prepare(
      `SELECT m.id AS messageId,
              m.thread_id AS threadId,
              m.mailbox_id AS mailboxId,
              m.subject AS subject,
              m.snippet AS snippet,
              m.from_name AS fromName,
              m.from_addr AS fromAddr,
              m.direction AS direction,
              m.flags AS flags,
              m.received_at AS receivedAt,
              m.sent_at AS sentAt
         FROM message_fts f
         JOIN message m ON m.id = f.message_id
        WHERE f.mailbox_id IN (${placeholders})
          AND message_fts MATCH ?
        ORDER BY bm25(message_fts), coalesce(m.received_at, m.sent_at) DESC
        LIMIT ?`,
    ).bind(...ids, matchExpr, limit);

    const rows = await stmt.all<{
      messageId: string;
      threadId: string;
      mailboxId: string;
      subject: string;
      snippet: string;
      fromName: string | null;
      fromAddr: string;
      direction: "in" | "out";
      flags: number;
      receivedAt: number | null;
      sentAt: number | null;
    }>();

    const results = (rows.results ?? []).map((row) => ({
      messageId: row.messageId,
      threadId: row.threadId,
      mailboxId: row.mailboxId,
      mailboxAddress: addressById.get(row.mailboxId) ?? "",
      subject: row.subject,
      snippet: row.snippet,
      fromName: row.fromName,
      fromAddr: row.fromAddr,
      direction: row.direction,
      flags: row.flags,
      receivedAt: row.receivedAt ? new Date(row.receivedAt * 1000).toISOString() : null,
      sentAt: row.sentAt ? new Date(row.sentAt * 1000).toISOString() : null,
    }));

    return c.json({ results } satisfies SearchResultsDto);
  });

  return r;
}

function toFtsMatch(q: string): string {
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}*`).join(" ");
}
