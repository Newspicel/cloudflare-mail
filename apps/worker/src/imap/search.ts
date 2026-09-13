// SEARCH (RFC 3501 §6.4.4) evaluated in memory over the selected folder's
// snapshot. Text keys use the columns the web app already indexes (from/to/
// subject/bodyText); HEADER on any other field falls back to the raw message.
/* eslint-disable no-await-in-loop -- evaluated per message so header loads stay bounded */

import { Flag } from "@cfmail/shared/flags";
import { headerValues, parseHeaderBlock } from "./mime-tree.ts";
import {
  expandSequenceSet,
  isSequenceSet,
  ProtocolError,
  parseDate,
  type Tok,
  tokString,
} from "./protocol.ts";
import { internalDate, type UidEntry } from "./store.ts";

type Node =
  | { k: "all" }
  | { k: "none" }
  | { k: "not"; n: Node }
  | { k: "or"; a: Node; b: Node }
  | { k: "and"; list: Node[] }
  | { k: "set"; spec: string; uid: boolean }
  | { k: "bit"; bit: number; on: boolean }
  | { k: "answered"; on: boolean }
  | { k: "text"; field: "from" | "to" | "cc" | "bcc" | "subject" | "body" | "text"; s: string }
  | { k: "header"; name: string; s: string }
  | { k: "date"; which: "internal" | "sent"; op: "before" | "on" | "since"; d: Date }
  | { k: "size"; op: "larger" | "smaller"; n: number };

export function parseSearchKeys(toks: Tok[]): Node {
  let i = 0;
  const next = (): Tok => {
    const t = toks[i++];
    if (!t) throw new ProtocolError("missing search argument");
    return t;
  };
  const str = (): string => {
    const s = tokString(next());
    if (s === null) throw new ProtocolError("expected string");
    return s;
  };
  const date = (): Date => {
    const d = parseDate(str());
    if (!d) throw new ProtocolError("bad date");
    return d;
  };
  const num = (): number => {
    const n = Number(str());
    if (!Number.isSafeInteger(n) || n < 0) throw new ProtocolError("bad number");
    return n;
  };

  function key(): Node {
    const t = next();
    if (t.t === "list") return parseSearchKeys(t.v);
    const s = tokString(t) ?? "";
    const u = s.toUpperCase();
    if (isSequenceSet(s)) return { k: "set", spec: s, uid: false };
    switch (u) {
      case "ALL":
        return { k: "all" };
      case "ANSWERED":
        return { k: "answered", on: true };
      case "UNANSWERED":
        return { k: "answered", on: false };
      case "DELETED":
        return { k: "bit", bit: Flag.DELETED, on: true };
      case "UNDELETED":
        return { k: "bit", bit: Flag.DELETED, on: false };
      case "DRAFT":
        return { k: "bit", bit: Flag.DRAFT, on: true };
      case "UNDRAFT":
        return { k: "bit", bit: Flag.DRAFT, on: false };
      case "FLAGGED":
        return { k: "bit", bit: Flag.STARRED, on: true };
      case "UNFLAGGED":
        return { k: "bit", bit: Flag.STARRED, on: false };
      case "SEEN":
        return { k: "bit", bit: Flag.SEEN, on: true };
      case "UNSEEN":
        return { k: "bit", bit: Flag.SEEN, on: false };
      // Nothing is ever \Recent here.
      case "NEW":
      case "RECENT":
        return { k: "none" };
      case "OLD":
        return { k: "all" };
      case "KEYWORD":
        str();
        return { k: "none" };
      case "UNKEYWORD":
        str();
        return { k: "all" };
      case "NOT":
        return { k: "not", n: key() };
      case "OR":
        return { k: "or", a: key(), b: key() };
      case "BCC":
        return { k: "text", field: "bcc", s: str() };
      case "CC":
        return { k: "text", field: "cc", s: str() };
      case "FROM":
        return { k: "text", field: "from", s: str() };
      case "TO":
        return { k: "text", field: "to", s: str() };
      case "SUBJECT":
        return { k: "text", field: "subject", s: str() };
      case "BODY":
        return { k: "text", field: "body", s: str() };
      case "TEXT":
        return { k: "text", field: "text", s: str() };
      case "HEADER": {
        const name = str().toLowerCase();
        return { k: "header", name, s: str() };
      }
      case "BEFORE":
        return { k: "date", which: "internal", op: "before", d: date() };
      case "ON":
        return { k: "date", which: "internal", op: "on", d: date() };
      case "SINCE":
        return { k: "date", which: "internal", op: "since", d: date() };
      case "SENTBEFORE":
        return { k: "date", which: "sent", op: "before", d: date() };
      case "SENTON":
        return { k: "date", which: "sent", op: "on", d: date() };
      case "SENTSINCE":
        return { k: "date", which: "sent", op: "since", d: date() };
      case "LARGER":
        return { k: "size", op: "larger", n: num() };
      case "SMALLER":
        return { k: "size", op: "smaller", n: num() };
      case "UID": {
        const spec = str();
        if (!isSequenceSet(spec)) throw new ProtocolError("bad UID set");
        return { k: "set", spec, uid: true };
      }
      default:
        throw new ProtocolError(`unknown search key ${s}`);
    }
  }

  const list: Node[] = [];
  while (i < toks.length) list.push(key());
  return list.length === 1 ? list[0]! : { k: "and", list };
}

export interface SearchContext {
  entries: UidEntry[];
  raw: (entry: UidEntry) => Promise<Uint8Array>;
}

// Returns the matching entries in folder order.
export async function evaluateSearch(node: Node, ctx: SearchContext): Promise<UidEntry[]> {
  const seqs = ctx.entries.map((_, i) => i + 1);
  const uids = ctx.entries.map((e) => e.uid);
  const headerCache = new Map<string, Map<string, string[]>>();

  async function headersOf(e: UidEntry): Promise<Map<string, string[]>> {
    const hit = headerCache.get(e.msg.id);
    if (hit) return hit;
    const raw = await ctx.raw(e);
    const { headers } = parseHeaderBlock(raw, 0, raw.length);
    const map = new Map<string, string[]>();
    for (const h of headers) map.set(h.name, headerValues(headers, h.name));
    headerCache.set(e.msg.id, map);
    return map;
  }

  async function test(n: Node, e: UidEntry, idx: number): Promise<boolean> {
    switch (n.k) {
      case "all":
        return true;
      case "none":
        return false;
      case "not":
        return !(await test(n.n, e, idx));
      case "or":
        return (await test(n.a, e, idx)) || (await test(n.b, e, idx));
      case "and": {
        for (const c of n.list) if (!(await test(c, e, idx))) return false;
        return true;
      }
      case "set": {
        const members = expandSequenceSet(n.spec, n.uid ? uids : seqs);
        return members.includes(n.uid ? e.uid : idx + 1);
      }
      case "bit":
        return ((e.msg.flags & n.bit) !== 0) === n.on;
      case "answered":
        return e.answered === n.on;
      case "text":
        return matchText(n.field, n.s, e);
      case "header": {
        if (n.name === "from") return matchText("from", n.s, e);
        if (n.name === "to") return matchText("to", n.s, e);
        if (n.name === "cc") return matchText("cc", n.s, e);
        if (n.name === "bcc") return matchText("bcc", n.s, e);
        if (n.name === "subject") return matchText("subject", n.s, e);
        if (n.name === "message-id") return contains(e.msg.messageIdHdr ?? "", n.s);
        if (n.name === "in-reply-to") return contains(e.msg.inReplyTo ?? "", n.s);
        const values = (await headersOf(e)).get(n.name) ?? [];
        // An empty search string matches any message carrying the header.
        if (n.s === "") return values.length > 0;
        return values.some((v) => contains(v, n.s));
      }
      case "date": {
        const d =
          n.which === "internal" ? internalDate(e.msg) : (e.msg.sentAt ?? internalDate(e.msg));
        const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const ref = n.d.getTime();
        if (n.op === "before") return day < ref;
        if (n.op === "on") return day === ref;
        return day >= ref;
      }
      case "size":
        return n.op === "larger" ? e.msg.sizeBytes > n.n : e.msg.sizeBytes < n.n;
    }
  }

  const out: UidEntry[] = [];
  for (let i = 0; i < ctx.entries.length; i++) {
    const e = ctx.entries[i]!;
    if (await test(node, e, i)) out.push(e);
  }
  return out;
}

function contains(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function addrs(list: { name?: string; address: string }[] | null): string {
  return (list ?? []).map((a) => `${a.name ?? ""} ${a.address}`).join(" ");
}

function matchText(
  field: "from" | "to" | "cc" | "bcc" | "subject" | "body" | "text",
  s: string,
  e: UidEntry,
): boolean {
  const m = e.msg;
  switch (field) {
    case "from":
      return contains(`${m.fromName ?? ""} ${m.fromAddr}`, s);
    case "to":
      return contains(addrs(m.toAddrs), s);
    case "cc":
      return contains(addrs(m.ccAddrs), s);
    case "bcc":
      return contains(addrs(m.bccAddrs), s);
    case "subject":
      return contains(m.subject, s);
    case "body":
      return contains(m.bodyText ?? "", s);
    case "text":
      return contains(
        `${m.subject} ${m.fromName ?? ""} ${m.fromAddr} ${m.toText ?? ""} ${m.bodyText ?? ""}`,
        s,
      );
  }
}
