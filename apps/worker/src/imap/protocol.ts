// IMAP4rev1 wire-level helpers (RFC 3501 §9): reading commands off the socket
// (with synchronizing and LITERAL+ literals), tokenizing them, sequence sets,
// date/string formatting, and modified-UTF-7 mailbox names. No mail semantics
// live here — session.ts interprets the tokens.
/* eslint-disable no-await-in-loop -- socket reads are inherently sequential */

const CRLF = new Uint8Array([13, 10]);
const enc = new TextEncoder();
const dec = new TextDecoder();
// Latin-1 keeps 8-bit bytes intact when a client sends non-UTF-8 in a quoted
// string; UTF-8 is tried first because that's what every modern client sends.
const latin1 = new TextDecoder("latin1");
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function bytesToString(b: Uint8Array): string {
  try {
    return utf8Strict.decode(b);
  } catch {
    return latin1.decode(b);
  }
}

// ─── Socket reader ──────────────────────────────────────────────────────────

export class LineReader {
  private buf = new Uint8Array(0);
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done || !value) {
      this.done = true;
      return false;
    }
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
    return true;
  }

  // One line without its terminator. Tolerates a bare LF (some clients slip).
  // Returns null once the peer closed the connection. `max` bounds the line so
  // a client can't grow the buffer without bound.
  async readLine(max = 64 * 1024): Promise<Uint8Array | null> {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl !== -1) {
        const end = nl > 0 && this.buf[nl - 1] === 13 ? nl - 1 : nl;
        const line = this.buf.slice(0, end);
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      if (this.buf.length > max) throw new ProtocolError("line too long");
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        const line = this.buf;
        this.buf = new Uint8Array(0);
        return line;
      }
    }
  }

  async readBytes(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) {
      if (!(await this.fill())) return null;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

export class ProtocolError extends Error {}

// A complete command: the first line plus any literals and their continuation
// lines, joined back into one buffer so the tokenizer sees `{n}\r\n<bytes>`
// inline. `sendContinuation` is called before each synchronizing literal.
export async function readCommand(
  reader: LineReader,
  sendContinuation: () => Promise<void>,
  maxLiteral: (bytesSoFar: Uint8Array, size: number) => boolean,
): Promise<Uint8Array | null> {
  let acc: Uint8Array | null = null;
  for (;;) {
    const line = await reader.readLine();
    if (line === null) return acc;
    acc = acc ? concat(acc, line) : line;
    const lit = trailingLiteral(line);
    if (!lit) return acc;
    if (!maxLiteral(acc, lit.size)) {
      // A synchronizing literal hasn't been sent yet, so refusing the
      // continuation is enough. LITERAL+ data is already on the wire: drain
      // it (and the rest of the command) so the next command parses cleanly.
      if (lit.plus) await drainRest(reader, lit.size);
      throw new LiteralTooLarge();
    }
    if (!lit.plus) await sendContinuation();
    const bytes = await reader.readBytes(lit.size);
    if (bytes === null) return null;
    acc = concat(concat(acc, CRLF), bytes);
  }
}

export class LiteralTooLarge extends Error {}

const DRAIN_MAX = 64 * 1024 * 1024;

async function drainRest(reader: LineReader, size: number): Promise<void> {
  if (size > DRAIN_MAX) throw new ProtocolError("literal too large to drain");
  if ((await reader.readBytes(size)) === null) return;
  for (;;) {
    const line = await reader.readLine();
    if (line === null) return;
    const lit = trailingLiteral(line);
    if (!lit) return;
    if (!lit.plus || lit.size > DRAIN_MAX) throw new ProtocolError("literal too large to drain");
    if ((await reader.readBytes(lit.size)) === null) return;
  }
}

function trailingLiteral(line: Uint8Array): { size: number; plus: boolean } | null {
  // Scan back from the end for `{digits[+]}`.
  let i = line.length - 1;
  if (i < 2 || line[i] !== 0x7d) return null; // }
  i--;
  let plus = false;
  if (line[i] === 0x2b) {
    plus = true;
    i--;
  }
  const end = i;
  while (i >= 0 && line[i]! >= 0x30 && line[i]! <= 0x39) i--;
  if (i === end || i < 0 || line[i] !== 0x7b) return null; // {
  const size = Number(dec.decode(line.slice(i + 1, end + 1)));
  if (!Number.isSafeInteger(size)) return null;
  return { size, plus };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

export type Tok =
  | { t: "atom"; v: string }
  | { t: "str"; v: string }
  | { t: "lit"; v: Uint8Array }
  | { t: "list"; v: Tok[] }
  // `[...]` following an atom (BODY[HEADER.FIELDS (From)]<0.100>): the atom
  // it decorates, the bracket contents, and an optional partial range.
  | { t: "sect"; base: string; v: Tok[]; partial: [number, number] | null };

const ATOM_STOP = new Set([0x20, 0x28, 0x29, 0x7b, 0x22, 0x5b, 0x5d, 0x0d, 0x0a]);

export function tokenize(buf: Uint8Array): Tok[] {
  let pos = 0;

  function skipSpaces(): void {
    while (pos < buf.length && buf[pos] === 0x20) pos++;
  }

  function readAtom(): string {
    const start = pos;
    while (pos < buf.length && !ATOM_STOP.has(buf[pos]!) && buf[pos]! > 0x1f) pos++;
    if (pos === start) throw new ProtocolError(`unexpected byte at ${pos}`);
    return dec.decode(buf.slice(start, pos));
  }

  function readQuoted(): string {
    pos++; // opening quote
    const bytes: number[] = [];
    while (pos < buf.length) {
      const c = buf[pos]!;
      if (c === 0x22) {
        pos++;
        return bytesToString(new Uint8Array(bytes));
      }
      if (c === 0x5c) {
        pos++;
        if (pos >= buf.length) break;
        bytes.push(buf[pos]!);
        pos++;
        continue;
      }
      if (c === 0x0d || c === 0x0a) throw new ProtocolError("newline in quoted string");
      bytes.push(c);
      pos++;
    }
    throw new ProtocolError("unterminated quoted string");
  }

  function readLiteral(): Uint8Array {
    // `{n}` or `{n+}` then CRLF then n bytes.
    const close = buf.indexOf(0x7d, pos);
    if (close === -1) throw new ProtocolError("bad literal");
    const spec = dec.decode(buf.slice(pos + 1, close));
    const size = Number(spec.endsWith("+") ? spec.slice(0, -1) : spec);
    if (!Number.isSafeInteger(size)) throw new ProtocolError("bad literal size");
    pos = close + 1;
    if (buf[pos] === 0x0d) pos++;
    if (buf[pos] === 0x0a) pos++;
    const out = buf.slice(pos, pos + size);
    if (out.length !== size) throw new ProtocolError("short literal");
    pos += size;
    return out;
  }

  function readPartial(): [number, number] | null {
    if (buf[pos] !== 0x3c) return null; // <
    const close = buf.indexOf(0x3e, pos);
    if (close === -1) throw new ProtocolError("bad partial");
    const spec = dec.decode(buf.slice(pos + 1, close));
    pos = close + 1;
    const m = /^(\d+)\.(\d+)$/.exec(spec);
    if (!m) throw new ProtocolError("bad partial");
    return [Number(m[1]), Number(m[2])];
  }

  function readSeq(closer: number | null): Tok[] {
    const out: Tok[] = [];
    for (;;) {
      skipSpaces();
      if (pos >= buf.length) {
        if (closer !== null) throw new ProtocolError("unterminated list");
        return out;
      }
      const c = buf[pos]!;
      if (closer !== null && c === closer) {
        pos++;
        return out;
      }
      if (c === 0x28) {
        pos++;
        out.push({ t: "list", v: readSeq(0x29) });
      } else if (c === 0x22) {
        out.push({ t: "str", v: readQuoted() });
      } else if (c === 0x7b) {
        out.push({ t: "lit", v: readLiteral() });
      } else if (c === 0x29 || c === 0x5d) {
        throw new ProtocolError(`unbalanced closer at ${pos}`);
      } else if (c === 0x5b) {
        // A bare `[` (e.g. `BODY []`)? Treat as a section on an empty base.
        pos++;
        out.push({ t: "sect", base: "", v: readSeq(0x5d), partial: readPartial() });
      } else {
        const atom = readAtom();
        if (buf[pos] === 0x5b) {
          pos++;
          out.push({ t: "sect", base: atom, v: readSeq(0x5d), partial: readPartial() });
        } else {
          out.push({ t: "atom", v: atom });
        }
      }
    }
  }

  return readSeq(null);
}

// astring / nstring accessors over tokens.
export function tokString(t: Tok | undefined): string | null {
  if (!t) return null;
  if (t.t === "atom" || t.t === "str") return t.v;
  if (t.t === "lit") return bytesToString(t.v);
  return null;
}

export function tokAtom(t: Tok | undefined): string | null {
  return t?.t === "atom" ? t.v : null;
}

export function tokList(t: Tok | undefined): Tok[] | null {
  return t?.t === "list" ? t.v : null;
}

// ─── Sequence sets ──────────────────────────────────────────────────────────

// Expand `1,3:5,7:*` against the numbers present in the mailbox. In sequence
// mode `present` is 1..n; in UID mode it's the sorted UIDs, and `*` means the
// largest. Ranges beyond what exists are clipped rather than rejected (RFC 3501
// allows `1:*` on an empty set, and clients ask for `2:*` speculatively).
export function expandSequenceSet(spec: string, present: number[]): number[] {
  if (present.length === 0) return [];
  const max = present[present.length - 1]!;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    if (!part) throw new ProtocolError("bad sequence set");
    const [lo, hi] = part.split(":");
    const a = parseSeqNum(lo!, max);
    const b = hi === undefined ? a : parseSeqNum(hi, max);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    for (const n of present) {
      if (n >= from && n <= to) out.add(n);
    }
  }
  return [...out].toSorted((x, y) => x - y);
}

function parseSeqNum(s: string, max: number): number {
  if (s === "*") return max;
  if (!/^\d+$/.test(s)) throw new ProtocolError("bad sequence number");
  const n = Number(s);
  if (n < 1) throw new ProtocolError("bad sequence number");
  return n;
}

export function isSequenceSet(s: string): boolean {
  return /^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(s);
}

// ─── Response formatting ────────────────────────────────────────────────────

// A quoted string when the value is 7-bit and free of CR/LF, else a literal
// (8-bit content isn't allowed inside IMAP4rev1 quoted strings).
export function astring(s: string): string | Uint8Array {
  if (isQuotable(s)) {
    return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  }
  const bytes = enc.encode(s);
  return concat(enc.encode(`{${bytes.length}}\r\n`), bytes);
}

// Printable 7-bit, no CR/LF/NUL: safe inside an IMAP4rev1 quoted string.
function isQuotable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || c === 10 || c === 13 || c > 0x7f) return false;
  }
  return true;
}

export function nstring(s: string | null | undefined): string | Uint8Array {
  return s == null ? "NIL" : astring(s);
}

export function literal(bytes: Uint8Array): Uint8Array {
  return concat(enc.encode(`{${bytes.length}}\r\n`), bytes);
}

// Join response fragments (strings and literal byte chunks) into one buffer.
export function joinParts(parts: (string | Uint8Array)[]): Uint8Array {
  let len = 0;
  const encoded = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  for (const e of encoded) len += e.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const e of encoded) {
    out.set(e, off);
    off += e.length;
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// INTERNALDATE / APPEND date-time: "dd-Mon-yyyy hh:mm:ss +0000" (always UTC).
const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatDateTime(d: Date): string {
  const p = pad2;
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function parseDateTime(s: string): Date | null {
  const m =
    /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mon === -1) return null;
  const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const off = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === "-" ? -1 : 1);
  return new Date(utc - off);
}

// SEARCH date: "dd-Mon-yyyy" → UTC midnight of that day.
export function parseDate(s: string): Date | null {
  const m = /^"?(\d{1,2})-([A-Za-z]{3})-(\d{4})"?$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mon === -1) return null;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
}

// ─── Modified UTF-7 (RFC 3501 §5.1.3) ───────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

export function encodeMutf7(s: string): string {
  let out = "";
  let run = "";
  const flush = () => {
    if (!run) return;
    // UTF-16BE, base64 with ',' for '/', no padding.
    const bytes: number[] = [];
    for (let i = 0; i < run.length; i++) {
      const c = run.charCodeAt(i);
      bytes.push(c >> 8, c & 0xff);
    }
    let b = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      const chars = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63];
      const keep = bytes.length - i >= 3 ? 4 : bytes.length - i === 2 ? 3 : 2;
      for (let k = 0; k < keep; k++) b += B64[chars[k]!];
    }
    out += `&${b}-`;
    run = "";
  };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x26) {
      flush();
      out += "&-";
    } else if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch;
    } else {
      run += ch;
    }
  }
  flush();
  return out;
}

export function decodeMutf7(s: string): string {
  return s.replace(/&([A-Za-z0-9+,]*)-/g, (_m, b64: string) => {
    if (b64 === "") return "&";
    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const ch of b64) {
      acc = (acc << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return out;
  });
}

// LIST pattern matching: `*` matches anything, `%` anything but the delimiter.
export function matchesPattern(name: string, pattern: string, delimiter: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "%") re += `[^${escapeRe(delimiter)}]*`;
    else re += escapeRe(ch);
  }
  re += "$";
  return new RegExp(re, "s").test(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
