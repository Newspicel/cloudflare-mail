// FTS5 search query builder, shared by every transport that searches mail: the
// REST endpoint (api/search.ts) and the MCP tool surface (mcp/store.ts). Only
// the SQL lives here — scoping a caller to the mailboxes it may read, and
// shaping rows for the wire, stay with the transport.

import type { SearchFilters, SearchIn } from "@cfmail/shared/schemas";

const STARRED = 1 << 1;

// Cap tokens per field and skip prefix (`*`) globbing on very short tokens —
// otherwise `q=a b c …` forces broad prefix scans over all readable body text.
const MAX_TOKENS = 16;
const MIN_PREFIX_LEN = 3;

export const SEARCH_SELECT_COLS = `m.id AS messageId,
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

export interface SearchRow {
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

// Compose the statement for one search over `mailboxIds`. Selects `limit + 1`
// rows so the caller can tell whether another page exists without a count.
export function buildSearchQuery(
  f: SearchFilters,
  mailboxIds: string[],
): { sql: string; binds: (string | number)[] } {
  const match = buildMatch(f);
  const binds: (string | number)[] = [];

  // WHERE clauses shared by both query shapes (text-search vs metadata-only).
  const where: string[] = [`m.mailbox_id IN (${mailboxIds.map(() => "?").join(",")})`];
  binds.push(...mailboxIds);

  applyFilters(f, where, binds);

  const attachExists = "EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id)";
  const date = "coalesce(m.received_at, m.sent_at)";
  const orderBy =
    f.sort === "relevance" && match
      ? `bm25(message_fts), ${date} DESC`
      : f.sort === "oldest"
        ? `${date} ASC`
        : `${date} DESC`;

  let sql: string;
  if (match) {
    where.unshift("message_fts MATCH ?");
    binds.unshift(match);
    sql = `SELECT ${SEARCH_SELECT_COLS}, (${attachExists}) AS hasAttachments
               FROM message_fts f
               JOIN message m ON m.id = f.message_id
               JOIN thread t ON t.id = m.thread_id
              WHERE ${where.join(" AND ")}
              ORDER BY ${orderBy}
              LIMIT ? OFFSET ?`;
  } else {
    sql = `SELECT ${SEARCH_SELECT_COLS}, (${attachExists}) AS hasAttachments
               FROM message m
               JOIN thread t ON t.id = m.thread_id
              WHERE ${where.join(" AND ")}
              ORDER BY ${orderBy}
              LIMIT ? OFFSET ?`;
  }
  binds.push(f.limit + 1, f.page * f.limit);

  return { sql, binds };
}

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
