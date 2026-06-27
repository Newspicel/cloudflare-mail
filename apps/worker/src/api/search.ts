import { domain, mailbox, mailboxMember } from "@cfmail/db/schema";
import { has, Perm } from "@cfmail/shared/permissions";
import type { SearchResultsDto } from "@cfmail/shared/responses";
import { type SearchFilters, type SearchIn, searchFilters } from "@cfmail/shared/schemas";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";

export function searchRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.get("/", async (c) => {
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

    const match = buildMatch(f);
    const ids = [...addressById.keys()];
    const binds: (string | number)[] = [];

    // WHERE clauses shared by both query shapes (text-search vs metadata-only).
    const where: string[] = [`m.mailbox_id IN (${ids.map(() => "?").join(",")})`];
    binds.push(...ids);

    applyFilters(f, where, binds);

    const attachExists = "EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id)";
    const limitPlus = f.limit + 1;
    const offset = f.page * f.limit;

    let sql: string;
    if (match) {
      where.unshift("message_fts MATCH ?");
      binds.unshift(match);
      sql = `SELECT ${SELECT_COLS}, (${attachExists}) AS hasAttachments
               FROM message_fts f
               JOIN message m ON m.id = f.message_id
               JOIN thread t ON t.id = m.thread_id
              WHERE ${where.join(" AND ")}
              ORDER BY bm25(message_fts), coalesce(m.received_at, m.sent_at) DESC
              LIMIT ? OFFSET ?`;
    } else {
      sql = `SELECT ${SELECT_COLS}, (${attachExists}) AS hasAttachments
               FROM message m
               JOIN thread t ON t.id = m.thread_id
              WHERE ${where.join(" AND ")}
              ORDER BY coalesce(m.received_at, m.sent_at) DESC
              LIMIT ? OFFSET ?`;
    }
    binds.push(limitPlus, offset);

    const rows = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all<Row>();
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

const SELECT_COLS = `m.id AS messageId,
       m.thread_id AS threadId,
       m.mailbox_id AS mailboxId,
       m.subject AS subject,
       m.snippet AS snippet,
       m.from_name AS fromName,
       m.from_addr AS fromAddr,
       m.direction AS direction,
       m.flags AS flags,
       m.received_at AS receivedAt,
       m.sent_at AS sentAt`;

interface Row {
  messageId: string;
  threadId: string;
  mailboxId: string;
  subject: string;
  snippet: string;
  fromName: string | null;
  fromAddr: string;
  direction: "in" | "out";
  flags: number;
  hasAttachments: number;
  receivedAt: number | null;
  sentAt: number | null;
}

const STARRED = 1 << 1;

// Append metadata WHERE clauses + their bind params (folder, direction, dates,
// attachments). Mutates `where`/`binds` in place.
function applyFilters(f: SearchFilters, where: string[], binds: (string | number)[]): void {
  switch (f.folder) {
    case "inbox":
      where.push("m.direction = 'in'", "t.trashed = 0", "t.spam = 0");
      break;
    case "sent":
      where.push("m.direction = 'out'", "t.trashed = 0");
      break;
    case "marked":
      where.push(`(m.flags & ${STARRED}) = ${STARRED}`, "t.trashed = 0");
      break;
    case "spam":
      where.push("t.spam = 1");
      break;
    case "trash":
      where.push("t.trashed = 1");
      break;
    default:
      where.push("t.trashed = 0", "t.spam = 0");
  }

  if (f.direction) {
    where.push("m.direction = ?");
    binds.push(f.direction);
  }
  if (f.hasAttachment) {
    where.push("EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id)");
  }
  if (f.after) {
    where.push("coalesce(m.received_at, m.sent_at) >= ?");
    binds.push(Math.floor(Date.parse(`${f.after}T00:00:00Z`) / 1000));
  }
  if (f.before) {
    where.push("coalesce(m.received_at, m.sent_at) <= ?");
    binds.push(Math.floor(Date.parse(`${f.before}T23:59:59Z`) / 1000));
  }
}

const SCOPE_COLS: Record<SearchIn, string | null> = {
  all: null,
  subject: "{subject}",
  from: "{from_text to_text}",
  body: "{body snippet}",
};

// Turn the free-text + field filters into an FTS5 MATCH expression. Returns "" to
// signal a metadata-only query (no text constraint).
function buildMatch(f: SearchFilters): string {
  const { positives, negatives } = splitQuery(f.q);
  const clauses: string[] = [];

  if (positives.length) {
    const scope = SCOPE_COLS[f.searchIn];
    const group = positives.join(" ");
    clauses.push(scope ? `${scope} : (${group})` : group);
  }
  const from = tokensOf(f.from);
  if (from.length) clauses.push(`{from_text to_text} : (${from.join(" ")})`);
  const to = tokensOf(f.to);
  if (to.length) clauses.push(`{to_text} : (${to.join(" ")})`);
  const subject = tokensOf(f.subject);
  if (subject.length) clauses.push(`{subject} : (${subject.join(" ")})`);

  if (!clauses.length) return "";

  const core = clauses.join(" ");
  const excludes = [...negatives, ...tokensOf(f.exclude)];
  // FTS5 has no unary NOT, so exclusions only apply alongside a positive match.
  return excludes.length ? `(${core}) NOT (${excludes.join(" OR ")})` : core;
}

// Cap tokens per field and skip prefix (`*`) globbing on very short tokens —
// otherwise `q=a b c …` forces broad prefix scans over all readable body text.
const MAX_TOKENS = 16;
const MIN_PREFIX_LEN = 3;

// Tokens long enough get a prefix match; shorter ones match exactly to avoid
// fanning out across the whole index.
function ftsToken(tok: string): string {
  return tok.length >= MIN_PREFIX_LEN ? `${tok}*` : tok;
}

// Split a query into prefix-matched positive tokens and `-`-prefixed negatives.
function splitQuery(q: string): { positives: string[]; negatives: string[] } {
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const raw of q.split(/\s+/)) {
    if (!raw) continue;
    if (positives.length + negatives.length >= MAX_TOKENS) break;
    const neg = raw.startsWith("-");
    const tok = sanitize(neg ? raw.slice(1) : raw);
    if (!tok) continue;
    (neg ? negatives : positives).push(ftsToken(tok));
  }
  return { positives, negatives };
}

function tokensOf(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((t) => sanitize(t))
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map(ftsToken);
}

function sanitize(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}
