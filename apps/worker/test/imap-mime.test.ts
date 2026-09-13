import { describe, expect, it } from "vitest";
import {
  extractSection,
  parseAddressList,
  parseSectionSpec,
  renderBodyStructure,
  renderEnvelope,
} from "../src/imap/fetch.ts";
import { ensureCrlf, parseMimeTree } from "../src/imap/mime-tree.ts";
import { joinParts } from "../src/imap/protocol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const MULTI = [
  "From: Alice <alice@example.com>",
  "To: Bob <bob@example.com>, carol@example.com",
  "Subject: Hello =?utf-8?q?W=C3=B6rld?=",
  "Date: Mon, 1 Jan 2024 10:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Hi Bob",
  "second line",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<p>Hi Bob</p>",
  "--b1--",
  "",
].join("\r\n");

function render(parts: (string | Uint8Array)[]): string {
  return dec.decode(joinParts(parts));
}

describe("parseMimeTree", () => {
  it("splits a multipart message into parts with exact byte ranges", () => {
    const raw = enc.encode(MULTI);
    const tree = parseMimeTree(raw);
    expect(tree.type).toBe("multipart");
    expect(tree.subtype).toBe("alternative");
    expect(tree.params.boundary).toBe("b1");
    expect(tree.children).toHaveLength(2);
    const [a, b] = tree.children;
    expect(a!.type).toBe("text");
    expect(a!.subtype).toBe("plain");
    expect(dec.decode(raw.subarray(a!.bodyStart, a!.end))).toBe("Hi Bob\r\nsecond line");
    expect(a!.lines).toBe(2);
    expect(b!.subtype).toBe("html");
    expect(b!.encoding).toBe("QUOTED-PRINTABLE");
    expect(dec.decode(raw.subarray(b!.bodyStart, b!.end))).toBe("<p>Hi Bob</p>");
  });

  it("nests message/rfc822", () => {
    const inner = "From: x@y.z\r\nSubject: inner\r\n\r\nbody\r\n";
    const outer = [
      "Subject: outer",
      'Content-Type: multipart/mixed; boundary="o"',
      "",
      "--o",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--o",
      "Content-Type: message/rfc822",
      "",
      inner,
      "--o--",
      "",
    ].join("\r\n");
    const raw = enc.encode(outer);
    const tree = parseMimeTree(raw);
    const att = tree.children[1]!;
    expect(att.message).not.toBeNull();
    expect(att.message!.headers.find((h) => h.name === "subject")?.value).toBe("inner");
    const body = extractSection(raw, tree, { path: [2], kind: "TEXT", fields: [] });
    expect(dec.decode(body!)).toBe("body\r\n");
  });
});

describe("BODYSTRUCTURE / ENVELOPE", () => {
  it("renders the extended structure", () => {
    const tree = parseMimeTree(enc.encode(MULTI));
    const s = render(renderBodyStructure(tree, true));
    expect(s).toBe(
      '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 19 2 NIL NIL NIL NIL)' +
        '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 13 1 NIL NIL NIL NIL)' +
        ' "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)',
    );
    expect(render(renderBodyStructure(tree, false))).toBe(
      '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 19 2)' +
        '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 13 1) "ALTERNATIVE")',
    );
  });

  it("renders the envelope without decoding encoded-words", () => {
    const tree = parseMimeTree(enc.encode(MULTI));
    const s = render(renderEnvelope(tree.headers));
    expect(s).toBe(
      '("Mon, 1 Jan 2024 10:00:00 +0000" "Hello =?utf-8?q?W=C3=B6rld?=" ' +
        '(("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) ' +
        '(("Alice" NIL "alice" "example.com")) ' +
        '(("Bob" NIL "bob" "example.com")(NIL NIL "carol" "example.com")) NIL NIL NIL "<m1@example.com>")',
    );
  });
});

describe("sections", () => {
  const raw = enc.encode(MULTI);
  const tree = parseMimeTree(raw);

  it("extracts header fields with the terminating blank line", () => {
    const sec = parseSectionSpec(["HEADER.FIELDS", ["Subject", "From"]])!;
    const out = dec.decode(extractSection(raw, tree, sec)!);
    expect(out).toBe(
      "From: Alice <alice@example.com>\r\nSubject: Hello =?utf-8?q?W=C3=B6rld?=\r\n\r\n",
    );
  });

  it("extracts numbered parts and their MIME headers", () => {
    expect(dec.decode(extractSection(raw, tree, parseSectionSpec(["1"])!)!)).toBe(
      "Hi Bob\r\nsecond line",
    );
    expect(dec.decode(extractSection(raw, tree, parseSectionSpec(["2.MIME"])!)!)).toBe(
      "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n",
    );
    expect(extractSection(raw, tree, parseSectionSpec(["3"])!)).toBeNull();
  });

  it("BODY[] and BODY[TEXT] cover the whole message and its body", () => {
    expect(extractSection(raw, tree, parseSectionSpec([])!)).toBe(raw);
    const text = dec.decode(extractSection(raw, tree, parseSectionSpec(["TEXT"])!)!);
    expect(text.startsWith("--b1\r\n")).toBe(true);
  });

  it("rejects malformed specs", () => {
    expect(parseSectionSpec(["BOGUS"])).toBeNull();
    expect(parseSectionSpec(["MIME"])).toBeNull();
    expect(parseSectionSpec(["HEADER.FIELDS"])).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("handles names, bare addresses, quoted commas and groups", () => {
    const list = parseAddressList(
      '"Doe, John" <john@x.com>, jane@y.org, Team: a@b.c, "B" <b@b.c>;, (c) x@y.z',
    );
    expect(list).toEqual([
      { name: "Doe, John", mailbox: "john", host: "x.com" },
      { name: null, mailbox: "jane", host: "y.org" },
      { name: null, mailbox: "Team", host: null, group: "start" },
      { name: null, mailbox: "a", host: "b.c" },
      { name: "B", mailbox: "b", host: "b.c" },
      { name: null, mailbox: null, host: null, group: "end" },
      { name: null, mailbox: "x", host: "y.z" },
    ]);
  });

  it("keeps a colon inside a display name out of the group syntax", () => {
    expect(parseAddressList("Meeting 10:30 <cal@x.com>")).toEqual([
      { name: "Meeting 10:30", mailbox: "cal", host: "x.com" },
    ]);
  });
});

describe("ensureCrlf", () => {
  it("leaves CRLF input alone and normalizes bare LF", () => {
    const ok = enc.encode("a\r\nb\r\n");
    expect(ensureCrlf(ok)).toBe(ok);
    expect(dec.decode(ensureCrlf(enc.encode("a\nb\r\nc\n")))).toBe("a\r\nb\r\nc\r\n");
  });
});
