import { describe, expect, it } from "vitest";
import type { ParsedEmail } from "../src/mail/mime.ts";
import {
  addrsToText,
  bodyForIndex,
  buildThreadingHeaders,
  extractUnsubscribe,
  htmlToText,
  normalizeSubject,
  snippet,
} from "../src/mail/mime.ts";

describe("normalizeSubject", () => {
  it("strips repeated reply/forward prefixes and lowercases", () => {
    expect(normalizeSubject("Re: Hello")).toBe("hello");
    expect(normalizeSubject("RE: FWD: Quarterly Report")).toBe("quarterly report");
    expect(normalizeSubject("Fw: AW: WG: thread")).toBe("thread");
  });

  it("trims surrounding whitespace before stripping", () => {
    expect(normalizeSubject("   Re:   Padded  ")).toBe("padded");
  });

  it("leaves words that merely start with a prefix alone", () => {
    expect(normalizeSubject("Research paper")).toBe("research paper");
    expect(normalizeSubject("Forwarding address change")).toBe("forwarding address change");
  });
});

describe("snippet", () => {
  it("collapses whitespace and trims", () => {
    expect(snippet("  hello\n\tworld   again ")).toBe("hello world again");
  });

  it("truncates to the requested length", () => {
    expect(snippet("abcdefghij", 4)).toBe("abcd");
  });

  it("defaults to a 180-char cap", () => {
    expect(snippet("x".repeat(500))).toHaveLength(180);
  });
});

describe("htmlToText", () => {
  it("drops script/style blocks entirely", () => {
    expect(htmlToText("<p>Hello <b>world</b></p><script>alert(1)</script>")).toBe("Hello world");
    expect(htmlToText("<style>.x{color:red}</style><div>Body</div>")).toBe("Body");
  });

  it("turns block-level tags into newlines", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(htmlToText("Line<br>Break")).toBe("Line\nBreak");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("a &amp; b &lt;tag&gt;")).toBe("a & b <tag>");
    expect(htmlToText("&#65;&#66;&#67;")).toBe("ABC");
  });

  it("strips HTML comments", () => {
    expect(htmlToText("<!-- hidden -->visible")).toBe("visible");
  });
});

describe("bodyForIndex", () => {
  it("prefers the trimmed text part", () => {
    expect(bodyForIndex("  plain text  ", "<p>html</p>")).toBe("plain text");
  });

  it("falls back to html when text is empty", () => {
    expect(bodyForIndex("", "<p>html body</p>")).toBe("html body");
    expect(bodyForIndex(null, "<div>fallback</div>")).toBe("fallback");
  });

  it("returns empty string when both are missing", () => {
    expect(bodyForIndex(null, null)).toBe("");
  });
});

describe("addrsToText", () => {
  it("flattens names and addresses into searchable text", () => {
    expect(addrsToText([{ name: "Bob", address: "bob@x.com" }, { address: "c@x.com" }])).toBe(
      "Bob bob@x.com c@x.com",
    );
  });

  it("skips missing names", () => {
    expect(addrsToText([{ address: "a@x.com" }])).toBe("a@x.com");
  });
});

describe("extractUnsubscribe", () => {
  const parsed = (headers: { key: string; value: string }[]) =>
    ({ headers }) as unknown as ParsedEmail;

  it("reads RFC 2369/8058 headers case-insensitively and trims", () => {
    expect(
      extractUnsubscribe(
        parsed([
          { key: "List-Unsubscribe", value: "  <mailto:u@x.com>  " },
          { key: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        ]),
      ),
    ).toEqual({
      listUnsubscribe: "<mailto:u@x.com>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
  });

  it("returns nulls when the headers are absent", () => {
    expect(extractUnsubscribe(parsed([]))).toEqual({
      listUnsubscribe: null,
      listUnsubscribePost: null,
    });
  });
});

describe("buildThreadingHeaders", () => {
  it("always sets Message-ID", () => {
    expect(buildThreadingHeaders({ messageId: "<a@x>" })).toEqual({ "Message-ID": "<a@x>" });
  });

  it("includes In-Reply-To and joined References when present", () => {
    expect(
      buildThreadingHeaders({
        messageId: "<c@x>",
        inReplyTo: "<b@x>",
        references: ["<a@x>", "<b@x>"],
      }),
    ).toEqual({
      "Message-ID": "<c@x>",
      "In-Reply-To": "<b@x>",
      References: "<a@x> <b@x>",
    });
  });

  it("omits References when the list is empty", () => {
    expect(buildThreadingHeaders({ messageId: "<a@x>", references: [] })).toEqual({
      "Message-ID": "<a@x>",
    });
  });
});
