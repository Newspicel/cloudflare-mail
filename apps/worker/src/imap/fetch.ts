// FETCH data items rendered from a raw message: ENVELOPE, BODY/BODYSTRUCTURE
// (RFC 3501 §7.4.2) and BODY[section] byte extraction. Envelope fields are
// passed through undecoded, as the RFC requires — clients decode encoded-words.

import { type Header, headerValue, type MimePart, parseHeaderBlock } from "./mime-tree.ts";
import { astring, nstring } from "./protocol.ts";

type Part = string | Uint8Array;

// ─── Addresses ──────────────────────────────────────────────────────────────

export interface Address {
  name: string | null;
  mailbox: string | null;
  host: string | null;
  group?: "start" | "end";
}

// Minimal RFC 5322 address-list parser over a raw (undecoded) header value:
// display names, angle-addr, bare addr-spec, comments, quoted strings, and
// groups. Anything malformed degrades to a best-effort mailbox rather than
// throwing — a broken From header must not break FETCH for the whole message.
export function parseAddressList(value: string | null): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  const items = splitTopLevel(value);
  for (const item of items) {
    const s = item.trim();
    if (!s) continue;
    // group: "name: a, b;" — only when the whole item is the group form, so a
    // colon inside a display name ("Meeting 10:30 <a@b>") isn't mistaken for one.
    const colon = findUnquoted(s, ":");
    if (
      colon !== -1 &&
      s.endsWith(";") &&
      (findUnquoted(s, "<") === -1 || findUnquoted(s, "<") > colon)
    ) {
      const gname = stripQuotes(s.slice(0, colon).trim());
      const inner = s.slice(colon + 1).replace(/;\s*$/, "");
      out.push({ name: null, mailbox: gname, host: null, group: "start" });
      for (const a of parseAddressList(inner)) out.push(a);
      out.push({ name: null, mailbox: null, host: null, group: "end" });
      continue;
    }
    const lt = findUnquoted(s, "<");
    const gt = lt === -1 ? -1 : s.indexOf(">", lt);
    let name: string | null = null;
    let addr: string;
    if (lt !== -1 && gt !== -1) {
      name = stripComments(s.slice(0, lt)).trim();
      addr = s.slice(lt + 1, gt).trim();
    } else {
      addr = stripComments(s).trim();
    }
    // RFC 5322 route (`@a,@b:user@host`) — drop the route.
    const route = addr.lastIndexOf(":");
    if (route !== -1 && addr.startsWith("@")) addr = addr.slice(route + 1);
    const at = addr.lastIndexOf("@");
    const mailbox = at === -1 ? addr : addr.slice(0, at);
    const host = at === -1 ? null : addr.slice(at + 1);
    out.push({
      name: name ? stripQuotes(name) || null : null,
      mailbox: mailbox || null,
      host: host || null,
    });
  }
  return out;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  let angle = false;
  // Group members ("Team: a@b, c@d;") stay together. Colons only open a group
  // when the header actually closes one somewhere, so "Meeting 10:30 <x@y>"
  // still splits on its commas.
  const groups = findUnquoted(s, ";") !== -1;
  let inGroup = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && (quoted || depth) && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (c === '"' && !depth) quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")" && depth) depth--;
    else if (!quoted && !depth && c === "<") angle = true;
    else if (!quoted && !depth && c === ">") angle = false;
    else if (groups && !quoted && !depth && !angle && c === ":") inGroup = true;
    else if (groups && !quoted && !depth && !angle && c === ";") inGroup = false;
    if (c === "," && !quoted && !depth && !angle && !inGroup) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function findUnquoted(s: string, ch: string): number {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (c === '"' && !depth) quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")" && depth) depth--;
    else if (!quoted && !depth && c === ch) return i;
  }
  return -1;
}

function stripComments(s: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      if (!depth) out += c + s[i + 1];
      i++;
      continue;
    }
    if (c === '"' && !depth) quoted = !quoted;
    if (!quoted && c === "(") {
      depth++;
      continue;
    }
    if (!quoted && c === ")" && depth) {
      depth--;
      continue;
    }
    if (!depth) out += c;
  }
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return t;
}

function renderAddressList(list: Address[]): Part[] {
  if (list.length === 0) return ["NIL"];
  const parts: Part[] = ["("];
  for (const a of list) {
    if (a.group === "start") parts.push("(NIL NIL ", nstring(a.mailbox), " NIL)");
    else if (a.group === "end") parts.push("(NIL NIL NIL NIL)");
    else parts.push("(", nstring(a.name), " NIL ", nstring(a.mailbox), " ", nstring(a.host), ")");
  }
  parts.push(")");
  return parts;
}

// ─── ENVELOPE ───────────────────────────────────────────────────────────────

export function renderEnvelope(headers: Header[]): Part[] {
  const from = parseAddressList(headerValue(headers, "from"));
  const sender = parseAddressList(headerValue(headers, "sender"));
  const replyTo = parseAddressList(headerValue(headers, "reply-to"));
  return [
    "(",
    nstring(headerValue(headers, "date")),
    " ",
    nstring(headerValue(headers, "subject")),
    " ",
    ...renderAddressList(from),
    " ",
    ...renderAddressList(sender.length ? sender : from),
    " ",
    ...renderAddressList(replyTo.length ? replyTo : from),
    " ",
    ...renderAddressList(parseAddressList(headerValue(headers, "to"))),
    " ",
    ...renderAddressList(parseAddressList(headerValue(headers, "cc"))),
    " ",
    ...renderAddressList(parseAddressList(headerValue(headers, "bcc"))),
    " ",
    nstring(headerValue(headers, "in-reply-to")),
    " ",
    nstring(headerValue(headers, "message-id")),
    ")",
  ];
}

// ─── BODY / BODYSTRUCTURE ───────────────────────────────────────────────────

function renderParams(params: Record<string, string>): Part[] {
  const keys = Object.keys(params);
  if (keys.length === 0) return ["NIL"];
  const parts: Part[] = ["("];
  keys.forEach((k, i) => {
    if (i) parts.push(" ");
    parts.push(astring(k.toUpperCase()), " ", astring(params[k]!));
  });
  parts.push(")");
  return parts;
}

function renderDisposition(d: MimePart["disposition"]): Part[] {
  if (!d) return ["NIL"];
  return ["(", astring(d.type.toUpperCase()), " ", ...renderParams(d.params), ")"];
}

export function renderBodyStructure(part: MimePart, extended: boolean): Part[] {
  if (part.type === "multipart") {
    const parts: Part[] = ["("];
    if (part.children.length === 0) {
      // A multipart with no parsable parts: present an empty text part so the
      // structure stays well-formed for clients.
      parts.push('("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 0 0');
      if (extended) parts.push(" NIL NIL NIL NIL");
      parts.push(")");
    }
    for (const child of part.children) parts.push(...renderBodyStructure(child, extended));
    parts.push(" ", astring(part.subtype.toUpperCase()));
    if (extended) {
      parts.push(" ", ...renderParams(part.params), " ", ...renderDisposition(part.disposition));
      parts.push(" NIL NIL");
    }
    parts.push(")");
    return parts;
  }

  const size = part.end - part.bodyStart;
  const parts: Part[] = [
    "(",
    astring(part.type.toUpperCase()),
    " ",
    astring(part.subtype.toUpperCase()),
    " ",
    ...renderParams(part.params),
    " ",
    nstring(part.id),
    " ",
    nstring(part.description),
    " ",
    astring(part.encoding),
    " ",
    String(size),
  ];
  if (part.type === "text") {
    parts.push(" ", String(part.lines));
  } else if (part.message) {
    parts.push(
      " ",
      ...renderEnvelope(part.message.headers),
      " ",
      ...renderBodyStructure(part.message, extended),
      " ",
      String(part.lines),
    );
  }
  if (extended) {
    parts.push(" NIL ", ...renderDisposition(part.disposition), " NIL NIL");
  }
  parts.push(")");
  return parts;
}

// ─── BODY[section] ──────────────────────────────────────────────────────────

export interface Section {
  path: number[]; // part numbers, e.g. [1, 2]
  // What to take from the addressed part.
  kind: "" | "HEADER" | "TEXT" | "MIME" | "HEADER.FIELDS" | "HEADER.FIELDS.NOT";
  fields: string[]; // for HEADER.FIELDS[.NOT], lowercase
}

export function parseSectionSpec(items: (string | string[])[]): Section | null {
  const section: Section = { path: [], kind: "", fields: [] };
  if (items.length === 0) return section;
  const first = items[0];
  if (typeof first !== "string") return null;
  const segs = first.split(".");
  let i = 0;
  while (i < segs.length && /^\d+$/.test(segs[i]!)) {
    section.path.push(Number(segs[i]));
    i++;
  }
  const rest = segs.slice(i).join(".").toUpperCase();
  if (rest === "") {
    if (items.length > 1) return null;
    return section;
  }
  if (rest === "HEADER" || rest === "TEXT" || rest === "MIME") {
    if (items.length > 1) return null;
    if (rest === "MIME" && section.path.length === 0) return null;
    section.kind = rest;
    return section;
  }
  if (rest === "HEADER.FIELDS" || rest === "HEADER.FIELDS.NOT") {
    const list = items[1];
    if (!Array.isArray(list) || items.length !== 2) return null;
    section.kind = rest;
    section.fields = list.map((f) => f.toLowerCase());
    return section;
  }
  return null;
}

// The bytes a section addresses, or null when the part doesn't exist.
export function extractSection(
  raw: Uint8Array,
  root: MimePart,
  section: Section,
): Uint8Array | null {
  let node: MimePart = root;
  for (let i = 0; i < section.path.length; i++) {
    const idx = section.path[i]!;
    const last = i === section.path.length - 1;
    if (node.children.length) {
      const child = node.children[idx - 1];
      if (!child) return null;
      node = child;
    } else if (node.message) {
      const inner = node.message;
      if (inner.children.length) {
        const child = inner.children[idx - 1];
        if (!child) return null;
        node = child;
      } else if (idx === 1) {
        node = inner;
      } else return null;
    } else if (idx === 1 && last) {
      // `BODY[1]` of a non-multipart message is its body.
    } else return null;
  }

  const bodyOf = (p: MimePart) => raw.subarray(p.bodyStart, p.end);
  const headerOf = (p: MimePart) => raw.subarray(p.start, p.bodyStart);

  switch (section.kind) {
    case "":
      return section.path.length === 0 ? raw : bodyOf(node);
    case "MIME":
      return headerOf(node);
    case "HEADER":
    case "TEXT":
    case "HEADER.FIELDS":
    case "HEADER.FIELDS.NOT": {
      // Inside a part path these apply to an embedded message/rfc822.
      let target = node;
      if (section.path.length > 0) {
        if (!node.message) return null;
        target = node.message;
      }
      if (section.kind === "TEXT") return bodyOf(target);
      if (section.kind === "HEADER") return headerOf(target);
      return filterHeaderFields(raw, target, section.fields, section.kind === "HEADER.FIELDS.NOT");
    }
  }
}

// Raw header lines (folding preserved) for the selected fields, terminated by
// the blank line as RFC 3501 requires.
function filterHeaderFields(
  raw: Uint8Array,
  part: MimePart,
  fields: string[],
  negate: boolean,
): Uint8Array {
  const { bodyStart } = parseHeaderBlock(raw, part.start, part.end);
  const block = new TextDecoder("latin1").decode(raw.subarray(part.start, bodyStart));
  // Split into logical (folded) header lines.
  const lines = block.split(/\r?\n/);
  const logical: string[] = [];
  for (const l of lines) {
    if (l === "") continue;
    if ((l.startsWith(" ") || l.startsWith("\t")) && logical.length) {
      logical[logical.length - 1] += `\r\n${l}`;
    } else logical.push(l);
  }
  const want = new Set(fields);
  const keep = logical.filter((l) => {
    const colon = l.indexOf(":");
    if (colon <= 0) return false;
    const name = l.slice(0, colon).trim().toLowerCase();
    return want.has(name) !== negate;
  });
  const text = keep.length ? `${keep.join("\r\n")}\r\n\r\n` : "\r\n";
  return latin1Encode(text);
}

function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// The section name as it must be echoed back in the FETCH response.
export function sectionLabel(section: Section): string {
  const path = section.path.join(".");
  let kind: string = section.kind;
  if (section.kind === "HEADER.FIELDS" || section.kind === "HEADER.FIELDS.NOT") {
    kind = `${section.kind} (${section.fields.map((f) => f.toUpperCase()).join(" ")})`;
  }
  return [path, kind].filter(Boolean).join(".");
}
