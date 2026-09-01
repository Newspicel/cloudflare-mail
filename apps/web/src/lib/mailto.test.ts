import { describe, expect, it } from "vitest";
import { buildMailto, parseMailto } from "./mailto.ts";

describe("parseMailto", () => {
  it("rejects non-mailto hrefs", () => {
    expect(parseMailto("https://example.com")).toBeNull();
  });

  it("reads addresses from the path", () => {
    expect(parseMailto("mailto:a@b.com,c@d.com")?.to).toEqual(["a@b.com", "c@d.com"]);
  });

  it("reads headers and merges a `to` query onto the path", () => {
    const f = parseMailto("mailto:a@b.com?to=c@d.com&cc=e@f.com&subject=Hi%20there&body=Line%0A2");
    expect(f).toEqual({
      to: ["a@b.com", "c@d.com"],
      cc: ["e@f.com"],
      bcc: [],
      subject: "Hi there",
      body: "Line\n2",
    });
  });

  it("keeps `+` literal in addresses and text", () => {
    const f = parseMailto("mailto:?to=foo%2Btag@bar.com&subject=a+b");
    expect(f?.to).toEqual(["foo+tag@bar.com"]);
    expect(f?.subject).toBe("a+b");
  });

  it("survives a malformed escape", () => {
    expect(parseMailto("mailto:a@b.com?subject=100%")?.subject).toBe("100%");
  });

  it("handles an empty target", () => {
    expect(parseMailto("mailto:")).toEqual({ to: [], cc: [], bcc: [] });
  });

  it("round-trips through buildMailto", () => {
    const f = parseMailto("mailto:a@b.com?cc=c@d.com&subject=Hi%20there&body=x%20y");
    expect(f).not.toBeNull();
    expect(parseMailto(buildMailto(f ?? {}))).toEqual(f);
  });

  it("builds a bare mailto: for empty fields", () => {
    expect(buildMailto({})).toBe("mailto:");
  });
});
