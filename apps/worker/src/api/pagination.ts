import { type AnyColumn, type SQL, sql } from "drizzle-orm";

// Shared keyset (cursor) pagination for the descending list endpoints. Lists
// order by `(<timestamp> DESC, id DESC)`; a cursor encodes the last row of a page
// as `<epochSeconds>_<id>`. Timestamps are stored as integer seconds and ids are
// UUIDs (no underscore), so a first-underscore split is unambiguous.

export interface Cursor {
  ts: number;
  id: string;
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  const i = raw.indexOf("_");
  if (i <= 0) return undefined;
  const ts = Number(raw.slice(0, i));
  const id = raw.slice(i + 1);
  return Number.isFinite(ts) && id ? { ts, id } : undefined;
}

/** Rows strictly older than the cursor under the `(tsCol, idCol)` keyset. */
export function cursorBefore(
  cur: Cursor | undefined,
  tsCol: AnyColumn,
  idCol: AnyColumn,
): SQL | undefined {
  if (!cur) return undefined;
  return sql`(${tsCol} < ${cur.ts} or (${tsCol} = ${cur.ts} and ${idCol} < ${cur.id}))`;
}

/** Cursor of the last row, or null when the page wasn't full (no more rows). */
export function nextCursor<T>(
  rows: T[],
  limit: number,
  pick: (row: T) => { ts: Date; id: string },
): string | null {
  if (rows.length < limit) return null;
  const last = pick(rows[rows.length - 1]!);
  return `${Math.floor(last.ts.getTime() / 1000)}_${last.id}`;
}
