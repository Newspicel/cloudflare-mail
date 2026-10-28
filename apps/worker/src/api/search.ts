import { domain, mailbox, mailboxMember } from "@cfmail/db/schema";
import { has, Perm } from "@cfmail/shared/permissions";
import type { SearchResultsDto } from "@cfmail/shared/responses";
import { searchFilters } from "@cfmail/shared/schemas";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { buildSearchQuery, type SearchRow } from "../mail/search-query.ts";
import { requireUser } from "../middleware.ts";

export function searchRoutes() {
  const r = new Hono<AppBindings>()
    .use("*", requireUser)

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const parsed = searchFilters.safeParse(c.req.query());
      if (!parsed.success) throw new HTTPException(400, { message: "invalid search filters" });
      const f = parsed.data;

      // Resolve every mailbox the caller may read (owned + shared with READ) in one
      // pass: left-join membership so an owner row has a null perms.
      const readable = await db
        .select({
          id: mailbox.id,
          localPart: mailbox.localPart,
          domainName: domain.name,
          ownerUserId: mailbox.ownerUserId,
          perms: mailboxMember.perms,
        })
        .from(mailbox)
        .innerJoin(domain, eq(mailbox.domainId, domain.id))
        .leftJoin(
          mailboxMember,
          and(eq(mailboxMember.mailboxId, mailbox.id), eq(mailboxMember.userId, user.id)),
        )
        .where(or(eq(mailbox.ownerUserId, user.id), eq(mailboxMember.userId, user.id)));

      const addressById = new Map<string, string>();
      for (const m of readable) {
        if (m.ownerUserId === user.id || (m.perms != null && has(m.perms, Perm.READ))) {
          addressById.set(m.id, `${m.localPart}@${m.domainName}`);
        }
      }

      // Scope to the requested mailbox(es) ("all"/blank = every readable one; a
      // comma-separated list of ids = just those, intersected with what's readable).
      if (f.mailboxId && f.mailboxId !== "all") {
        const wanted = new Set(
          f.mailboxId
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        for (const id of addressById.keys()) {
          if (!wanted.has(id)) addressById.delete(id);
        }
        if (addressById.size === 0) throw new HTTPException(403, { message: "forbidden" });
      }
      if (addressById.size === 0) {
        return c.json({ results: [], hasMore: false } satisfies SearchResultsDto);
      }

      const { sql, binds } = buildSearchQuery(f, [...addressById.keys()]);
      const rows = await c.env.DB.prepare(sql)
        .bind(...binds)
        .all<SearchRow>();
      const all = rows.results ?? [];
      const hasMore = all.length > f.limit;
      const page = hasMore ? all.slice(0, f.limit) : all;

      const results = page.map((row) => ({
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
        hasAttachments: row.hasAttachments === 1,
        receivedAt: row.receivedAt ? new Date(row.receivedAt * 1000).toISOString() : null,
        sentAt: row.sentAt ? new Date(row.sentAt * 1000).toISOString() : null,
      }));

      return c.json({ results, hasMore } satisfies SearchResultsDto);
    });

  return r;
}
