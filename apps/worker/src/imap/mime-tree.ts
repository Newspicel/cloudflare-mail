// Byte-offset MIME tree over a raw message. FETCH needs exact byte ranges for
// BODY[section] and per-part sizes/line counts for BODYSTRUCTURE, which a
// decoding parser (postal-mime) doesn't expose — so this walks the raw bytes,
// splitting on boundaries and recording where every header block and body
// starts and ends. Nothing is decoded.

export interface Header {
  name: string; // lowercase
  value: string; // unfolded
}

export interface MimePart {
  start: number; // first byte of this part's header block
  bodyStart: number; // first byte after the blank line ending the headers
  end: number; // exclusive
  headers: Header[];
  type: string; // lowercase
  subtype: string; // lowercase
  params: Record<string, string>;
  encoding: string;
  id: string | null;
  description: string | null;
  disposition: { type: string; params: Record<string, string> } | null;
  children: MimePart[]; // multipart/*
  message: MimePart | null; // message/rfc822
  lines: number; // body line count
}

const dec = new TextDecoder("latin1");

export function parseMimeTree(raw: Uint8Array, depth = 0): MimePart {
  return parsePart(raw, 0, raw.length, depth);
}

function parsePart(raw: Uint8Array, start: number, end: number, depth: number): MimePart {
  const { headers, bodyStart } = parseHeaderBlock(raw, start, end);
  const ct = parseContentType(headerValue(headers, "content-type"));
  const part: MimePart = {
    start,
    bodyStart,
    end,
    headers,
    type: ct.type,
    subtype: ct.subtype,
    params: ct.params,
    encoding: (headerValue(headers, "content-transfer-encoding") ?? "7BIT").trim().toUpperCase(),
    id: headerValue(headers, "content-id"),
    description: headerValue(headers, "content-description"),
    disposition: parseDisposition(headerValue(headers, "content-disposition")),
    children: [],
    message: null,
    lines: countLines(raw, bodyStart, end),
  };

  // Bound nesting so a hostile message can't recurse forever.
  if (depth >= 32) return part;

  if (part.type === "multipart" && part.params.boundary) {
    part.children = splitMultipart(raw, bodyStart, end, part.params.boundary).map(([s, e]) =>
      parsePart(raw, s, e, depth + 1),
    );
  } else if (part.type === "message" && part.subtype === "rfc822") {
    part.message = parsePart(raw, bodyStart, end, depth + 1);
  }
  return part;
}

// Headers end at the first blank line. Returns the unfolded headers and the
// offset of the body (just past the blank line).
export function parseHeaderBlock(
  raw: Uint8Array,
  start: number,
  end: number,
): { headers: Header[]; bodyStart: number } {
  const lines: string[] = [];
  let pos = start;
  let bodyStart = end;
  while (pos < end) {
    let nl = raw.indexOf(10, pos);
    if (nl === -1 || nl >= end) nl = end;
    let lineEnd = nl;
    if (lineEnd > pos && raw[lineEnd - 1] === 13) lineEnd--;
    const next = nl < end ? nl + 1 : end;
    if (lineEnd === pos) {
      bodyStart = next;
      break;
    }
    const line = dec.decode(raw.subarray(pos, lineEnd));
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line;
    } else {
      lines.push(line);
    }
    pos = next;
    if (pos >= end) bodyStart = end;
  }
  const headers: Header[] = [];
  for (const l of lines) {
    const colon = l.indexOf(":");
    if (colon <= 0) continue;
    headers.push({
      name: l.slice(0, colon).trim().toLowerCase(),
      value: l.slice(colon + 1).trim(),
    });
  }
  return { headers, bodyStart };
}

export function headerValue(headers: Header[], name: string): string | null {
  const h = headers.find((x) => x.name === name);
  return h ? h.value : null;
}

export function headerValues(headers: Header[], name: string): string[] {
  return headers.filter((x) => x.name === name).map((x) => x.value);
}

function countLines(raw: Uint8Array, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) if (raw[i] === 10) n++;
  // A final line without a terminator still counts.
  if (end > start && raw[end - 1] !== 10) n++;
  return n;
}

// Body ranges of each part between `--boundary` delimiters. Each range starts
// after the delimiter line and ends before the CRLF that precedes the next one.
function splitMultipart(
  raw: Uint8Array,
  start: number,
  end: number,
  boundary: string,
): [number, number][] {
  const delim = new TextEncoder().encode(`--${boundary}`);
  const marks: { at: number; lineEnd: number; closing: boolean }[] = [];
  let pos = start;
  while (pos < end) {
    const hit = indexOf(raw, delim, pos, end);
    if (hit === -1) break;
    // Must be at a line start.
    if (hit !== start && raw[hit - 1] !== 10) {
      pos = hit + 1;
      continue;
    }
    let p = hit + delim.length;
    const closing = raw[p] === 45 && raw[p + 1] === 45;
    if (closing) p += 2;
    // Rest of the line is transport padding.
    let nl = raw.indexOf(10, p);
    if (nl === -1 || nl > end) nl = end;
    marks.push({ at: hit, lineEnd: Math.min(nl + 1, end), closing });
    pos = nl + 1;
    if (closing) break;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    if (m.closing) break;
    const next = marks[i + 1];
    let partEnd = next ? next.at : end;
    if (next) {
      if (partEnd > m.lineEnd && raw[partEnd - 1] === 10) partEnd--;
      if (partEnd > m.lineEnd && raw[partEnd - 1] === 13) partEnd--;
    }
    out.push([m.lineEnd, Math.max(m.lineEnd, partEnd)]);
  }
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  const first = needle[0]!;
  outer: for (let i = from; i <= to - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// `type/subtype; a=b; c="d"` → lowercase type/subtype, params keyed lowercase.
export function parseContentType(v: string | null): {
  type: string;
  subtype: string;
  params: Record<string, string>;
} {
  if (!v) return { type: "text", subtype: "plain", params: {} };
  const { head, params } = splitParams(v);
  const slash = head.indexOf("/");
  const type = (slash === -1 ? head : head.slice(0, slash)).trim().toLowerCase() || "text";
  const subtype = (slash === -1 ? "" : head.slice(slash + 1)).trim().toLowerCase() || "plain";
  return { type, subtype, params };
}

function parseDisposition(
  v: string | null,
): { type: string; params: Record<string, string> } | null {
  if (!v) return null;
  const { head, params } = splitParams(v);
  return { type: head.trim().toLowerCase() || "attachment", params };
}

function splitParams(v: string): { head: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let i = 0;
  const readUntilSemi = (): string => {
    let out = "";
    let quoted = false;
    for (; i < v.length; i++) {
      const c = v[i]!;
      if (c === '"') quoted = !quoted;
      if (c === ";" && !quoted) break;
      out += c;
    }
    return out;
  };
  const head = readUntilSemi();
  while (i < v.length) {
    i++; // skip ';'
    const seg = readUntilSemi().trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    let name = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    // RFC 2231 continuations/charsets are flattened: name*0*= → name.
    const star = name.indexOf("*");
    if (star !== -1) name = name.slice(0, star);
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (name && !(name in params)) params[name] = val;
    else if (name && star !== -1) params[name] += val;
  }
  return { head, params };
}

// IMAP transmits messages with CRLF line endings; stored copies usually are
// already, but a bare-LF message (some imports) is normalized on the way out.
export function ensureCrlf(raw: Uint8Array): Uint8Array {
  let bare = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 10 && (i === 0 || raw[i - 1] !== 13)) bare++;
  }
  if (bare === 0) return raw;
  const out = new Uint8Array(raw.length + bare);
  let o = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    if (b === 10 && (i === 0 || raw[i - 1] !== 13)) out[o++] = 13;
    out[o++] = b;
  }
  return out;
}
