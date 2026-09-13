import { describe, expect, it } from "vitest";
import {
  astring,
  decodeMutf7,
  encodeMutf7,
  expandSequenceSet,
  formatDateTime,
  LineReader,
  matchesPattern,
  ProtocolError,
  parseDate,
  parseDateTime,
  readCommand,
  tokenize,
  tokString,
} from "../src/imap/protocol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamOf(...chunks: string[]): LineReader {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new LineReader(stream.getReader());
}

describe("tokenize", () => {
  it("splits atoms, quoted strings and lists", () => {
    const toks = tokenize(enc.encode('A1 LOGIN "me@x.com" p4ss-w0rd (a b)'));
    expect(toks.map((t) => t.t)).toEqual(["atom", "atom", "str", "atom", "list"]);
    expect(tokString(toks[2])).toBe("me@x.com");
    expect(tokString(toks[3])).toBe("p4ss-w0rd");
    const list = toks[4];
    expect(list?.t).toBe("list");
    expect(list?.t === "list" && list.v.map((x) => tokString(x))).toEqual(["a", "b"]);
  });

  it("unescapes quoted strings", () => {
    const toks = tokenize(enc.encode('A1 X "a \\"b\\" \\\\c"'));
    expect(tokString(toks[2])).toBe('a "b" \\c');
  });

  it("parses fetch sections with partials", () => {
    const toks = tokenize(
      enc.encode("A2 FETCH 1:* (FLAGS BODY.PEEK[HEADER.FIELDS (From To)]<0.100> BODY[])"),
    );
    const list = toks[3];
    expect(list?.t).toBe("list");
    if (list?.t !== "list") return;
    const sect = list.v[1];
    expect(sect?.t).toBe("sect");
    if (sect?.t !== "sect") return;
    expect(sect.base).toBe("BODY.PEEK");
    expect(sect.partial).toEqual([0, 100]);
    expect(tokString(sect.v[0])).toBe("HEADER.FIELDS");
    expect(sect.v[1]?.t).toBe("list");
    const empty = list.v[2];
    expect(empty?.t === "sect" && empty.v).toEqual([]);
  });

  it("reads inline literals", () => {
    const toks = tokenize(enc.encode("A3 APPEND INBOX {5}\r\nhello"));
    const lit = toks[3];
    expect(lit?.t).toBe("lit");
    expect(lit?.t === "lit" && dec.decode(lit.v)).toBe("hello");
  });

  it("rejects unterminated strings and lists", () => {
    expect(() => tokenize(enc.encode('A1 X "abc'))).toThrow(ProtocolError);
    expect(() => tokenize(enc.encode("A1 X (a b"))).toThrow(ProtocolError);
  });
});

describe("readCommand", () => {
  it("returns a plain line", async () => {
    const r = streamOf("A1 NOOP\r\nA2 NOOP\r\n");
    const cmd = await readCommand(
      r,
      async () => {},
      () => true,
    );
    expect(dec.decode(cmd!)).toBe("A1 NOOP");
  });

  it("sends a continuation for synchronizing literals and splices the bytes", async () => {
    const r = streamOf("A1 APPEND INBOX {5}\r\n", "hello", " (\\Seen)\r\n");
    const conts: number[] = [];
    const cmd = await readCommand(
      r,
      async () => {
        conts.push(1);
      },
      () => true,
    );
    expect(conts).toHaveLength(1);
    expect(dec.decode(cmd!)).toBe("A1 APPEND INBOX {5}\r\nhello (\\Seen)");
    const toks = tokenize(cmd!);
    expect(toks[3]?.t).toBe("lit");
    expect(toks[4]?.t).toBe("list");
  });

  it("skips the continuation for LITERAL+", async () => {
    const r = streamOf("A1 APPEND INBOX {5+}\r\nhello\r\n");
    let conts = 0;
    const cmd = await readCommand(
      r,
      async () => {
        conts++;
      },
      () => true,
    );
    expect(conts).toBe(0);
    expect(dec.decode(cmd!)).toBe("A1 APPEND INBOX {5+}\r\nhello");
  });

  it("returns null at end of stream", async () => {
    const r = streamOf("");
    expect(
      await readCommand(
        r,
        async () => {},
        () => true,
      ),
    ).toBeNull();
  });
});

describe("expandSequenceSet", () => {
  const present = [1, 2, 3, 4, 5];
  it("expands ranges, lists and *", () => {
    expect(expandSequenceSet("1:*", present)).toEqual([1, 2, 3, 4, 5]);
    expect(expandSequenceSet("2,4:5", present)).toEqual([2, 4, 5]);
    expect(expandSequenceSet("*", present)).toEqual([5]);
    expect(expandSequenceSet("5:2", present)).toEqual([2, 3, 4, 5]);
  });
  it("clips to what exists and handles empty mailboxes", () => {
    expect(expandSequenceSet("3:9", present)).toEqual([3, 4, 5]);
    expect(expandSequenceSet("1:*", [])).toEqual([]);
  });
  it("works on sparse UID sets", () => {
    expect(expandSequenceSet("10:*", [3, 10, 12, 40])).toEqual([10, 12, 40]);
  });
});

describe("modified UTF-7", () => {
  it("round-trips non-ASCII names", () => {
    expect(encodeMutf7("Entwürfe")).toBe("Entw&APw-rfe");
    expect(decodeMutf7("Entw&APw-rfe")).toBe("Entwürfe");
    expect(encodeMutf7("A&B")).toBe("A&-B");
    expect(decodeMutf7("A&-B")).toBe("A&B");
    for (const name of ["日本語", "Sent Items", "Ünïcödé & more"]) {
      expect(decodeMutf7(encodeMutf7(name))).toBe(name);
    }
  });
});

describe("matchesPattern", () => {
  it("handles * and %", () => {
    expect(matchesPattern("INBOX", "*", "/")).toBe(true);
    expect(matchesPattern("Projects/2026", "%", "/")).toBe(false);
    expect(matchesPattern("Projects/2026", "Projects/%", "/")).toBe(true);
    expect(matchesPattern("Sent", "INB*", "/")).toBe(false);
    expect(matchesPattern("INBOX", "INB*", "/")).toBe(true);
  });
});

describe("dates", () => {
  it("formats and parses INTERNALDATE", () => {
    const d = new Date(Date.UTC(2026, 8, 13, 7, 5, 9));
    expect(formatDateTime(d)).toBe("13-Sep-2026 07:05:09 +0000");
    expect(parseDateTime("13-Sep-2026 09:05:09 +0200")?.getTime()).toBe(d.getTime());
    expect(parseDateTime("garbage")).toBeNull();
  });
  it("parses search dates as UTC midnight", () => {
    expect(parseDate("1-Feb-2020")?.toISOString()).toBe("2020-02-01T00:00:00.000Z");
  });
});

describe("astring", () => {
  it("quotes 7-bit and falls back to a literal for 8-bit", () => {
    expect(astring('a "b"')).toBe('"a \\"b\\""');
    const lit = astring("Grüße");
    expect(lit).toBeInstanceOf(Uint8Array);
    expect(dec.decode(lit as Uint8Array)).toBe("{7}\r\nGrüße");
  });
});
