import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeEmailHtml } from "../src/mail/sanitize.ts";

describe("sanitizeEmailHtml — blocked elements", () => {
  it.each(["script", "iframe", "object"])("removes <%s> (including its content)", async (tag) => {
    const out = await sanitizeEmailHtml(`<div>before<${tag} src="x">inner</${tag}>after</div>`);
    expect(out).not.toContain(`<${tag}`);
    expect(out).not.toContain("inner");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  // embed/base are void elements — the parser gives them no content, so only
  // the tag itself is dropped.
  it.each(["embed", "base"])("removes <%s>", async (tag) => {
    const out = await sanitizeEmailHtml(`<div>before<${tag} src="x">after</div>`);
    expect(out).not.toContain(`<${tag}`);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("removes a script even with attributes and mixed case", async () => {
    const out = await sanitizeEmailHtml(
      `<SCRIPT type="text/javascript">alert(1)</SCRIPT><p>ok</p>`,
    );
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>ok</p>");
  });
});

describe("sanitizeEmailHtml — event handler attributes", () => {
  it("strips on* attributes from any element", async () => {
    const out = await sanitizeEmailHtml(
      `<img src="cid:x" onerror="steal()"><p onclick="x()" ONMOUSEOVER="y()">hi</p>`,
    );
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onmouseover/i);
    expect(out).toContain("hi");
    expect(out).toContain(`src="cid:x"`);
  });
});

describe("sanitizeEmailHtml — javascript: URLs", () => {
  it("drops a javascript: href", async () => {
    const out = await sanitizeEmailHtml(`<a href="javascript:alert(1)">click</a>`);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  it("drops a javascript: src", async () => {
    const out = await sanitizeEmailHtml(`<img src="javascript:alert(1)">`);
    expect(out).not.toContain("javascript:");
  });

  it("catches case and control-char obfuscation inside the scheme", async () => {
    const out = await sanitizeEmailHtml(
      `<a href="JaVaScRiPt:alert(1)">a</a>` +
        `<a href="java\nscript:alert(2)">b</a>` +
        `<a href="\tjavascript:alert(3)">c</a>` +
        `<a href="javascript:alert(4)">d</a>`,
    );
    expect(out).not.toMatch(/href/i);
  });

  it("keeps ordinary http(s) and mailto hrefs", async () => {
    const html = `<a href="https://example.com/x?y=1">x</a><a href="mailto:a@b.c">m</a>`;
    expect(await sanitizeEmailHtml(html)).toBe(html);
  });
});

describe("sanitizeEmailHtml — benign HTML", () => {
  it("passes benign markup through unchanged", async () => {
    const html =
      `<div class="wrap" style="color:#333"><h1>Hello</h1>` +
      `<p>Some <b>bold</b> and <i>italic</i> text.</p>` +
      `<table><tr><td>cell</td></tr></table>` +
      `<img src="/api/messages/proxy-image?u=abc&amp;s=def" alt="pic"></div>`;
    expect(await sanitizeEmailHtml(html)).toBe(html);
  });
});

describe("sanitizeEmailHtml — failure fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the input untouched when the rewriter blows up", async () => {
    vi.stubGlobal("HTMLRewriter", () => {
      throw new Error("rewriter unavailable");
    });
    const html = `<script>alert(1)</script>`;
    expect(await sanitizeEmailHtml(html)).toBe(html);
  });
});
