// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { splitQuotedHtml, splitQuotedText, stripQuotedSnippet } from "./split-quote.ts";

describe("splitQuotedHtml", () => {
  it("folds our own reply quote", () => {
    const { main, quote } = splitQuotedHtml(
      `<p>Thanks!</p><div class="cfmail-quote"><p>On Mon, A wrote:</p><blockquote>hi</blockquote></div>`,
    );
    expect(main).toBe("<p>Thanks!</p>");
    expect(quote).toContain("A wrote:");
  });

  it("folds a Gmail quote but keeps the signature-free reply", () => {
    const { main, quote } = splitQuotedHtml(
      `<div dir="ltr">Sure</div><br><div class="gmail_quote"><div class="gmail_attr">On x wrote:</div><blockquote class="gmail_quote">old</blockquote></div>`,
    );
    expect(main).toContain("Sure");
    expect(main).not.toContain("old");
    expect(quote).toContain("old");
  });

  it("cuts everything after Outlook's reply header", () => {
    const { main, quote } = splitQuotedHtml(
      `<p>Yes</p><hr><div id="divRplyFwdMsg">From: A</div><div>old body</div>`,
    );
    expect(main).toBe("<p>Yes</p>");
    expect(quote).toContain("old body");
    expect(quote).toContain("<hr>");
  });

  it("takes Thunderbird's cite prefix along", () => {
    const { main } = splitQuotedHtml(
      `<p>Ok</p><div class="moz-cite-prefix">On x wrote:</div><blockquote type="cite">old</blockquote>`,
    );
    expect(main).toBe("<p>Ok</p>");
  });

  it("leaves forwards whole", () => {
    const html = `<p>FYI</p><div class="gmail_quote">---------- Forwarded message ---------<br>body</div>`;
    expect(splitQuotedHtml(html)).toEqual({ main: html, quote: null });
  });

  it("does not fold a message that is only a quote", () => {
    const html = `<blockquote type="cite">old</blockquote>`;
    expect(splitQuotedHtml(html).quote).toBeNull();
  });
});

describe("splitQuotedText", () => {
  it("folds a trailing quote with its attribution", () => {
    const { main, quote } = splitQuotedText("Thanks!\n\nOn Mon, A wrote:\n> hi\n>\n> there\n");
    expect(main).toBe("Thanks!");
    expect(quote).toBe("On Mon, A wrote:\n> hi\n>\n> there");
  });

  it("handles a wrapped attribution line", () => {
    const { main } = splitQuotedText(
      "Ok\n\nOn Mon, 3 Nov 2026 at 10:00, Some Body\n<a@b.c> wrote:\n> hi",
    );
    expect(main).toBe("Ok");
  });

  it("cuts at an Original Message marker", () => {
    const { main, quote } = splitQuotedText("Yes\n\n-----Original Message-----\nFrom: A\nold");
    expect(main).toBe("Yes");
    expect(quote).toContain("From: A");
  });

  it("leaves inline quoting alone", () => {
    const text = "> question\nanswer\n> another\nanswer two";
    expect(splitQuotedText(text).quote).toBeNull();
  });
});

describe("stripQuotedSnippet", () => {
  it("cuts at the reply attribution", () => {
    expect(
      stripQuotedSnippet("Good idea, I'll book it. On Mon, 3 Nov 2026, Alice <a@b.c> wrote: hi"),
    ).toBe("Good idea, I'll book it.");
  });

  it("cuts at Outlook's header block", () => {
    expect(stripQuotedSnippet("Yes. From: Alice Sent: Monday To: Bob Subject: x")).toBe("Yes.");
  });

  it("keeps a snippet that is only a quote", () => {
    const s = "On Mon, Alice wrote: hi";
    expect(stripQuotedSnippet(s)).toBe(s);
  });

  it("leaves ordinary text alone", () => {
    const s = "On Monday we ship the release, as I wrote earlier.";
    expect(stripQuotedSnippet(s)).toBe(s);
  });
});
