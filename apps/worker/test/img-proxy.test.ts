import { describe, expect, it } from "vitest";
import {
  b64urlToStr,
  isBlockedHost,
  proxyRemoteContent,
  verifyProxyUrl,
} from "../src/mail/img-proxy.ts";

const SECRET = "test-secret";

// Pull the `u`/`s` params back out of the first proxy URL in a rewritten body.
function paramsOf(html: string): { u: string; s: string } {
  const match = html.match(/proxy-image\?([^"\s]+)/);
  const q = new URLSearchParams(match?.[1] ?? "");
  return { u: q.get("u") ?? "", s: q.get("s") ?? "" };
}

describe("proxyRemoteContent", () => {
  it("rewrites remote img src to a signed same-origin proxy URL", async () => {
    const out = await proxyRemoteContent('<img src="https://tracker.example/pixel.gif">', SECRET);
    expect(out).toContain("/api/messages/proxy-image?u=");
    expect(out).not.toContain("tracker.example");
    const { u, s } = paramsOf(out);
    expect(b64urlToStr(decodeURIComponent(u))).toBe("https://tracker.example/pixel.gif");
    expect(await verifyProxyUrl(SECRET, decodeURIComponent(u), decodeURIComponent(s))).toBe(
      "https://tracker.example/pixel.gif",
    );
  });

  it("leaves data: and cid: sources untouched", async () => {
    const html = '<img src="data:image/png;base64,AAAA"><img src="cid:logo@x">';
    expect(await proxyRemoteContent(html, SECRET)).toBe(html);
  });

  it("rewrites every candidate in a srcset", async () => {
    const out = await proxyRemoteContent(
      '<img srcset="https://a.example/1x.jpg 1x, https://a.example/2x.jpg 2x">',
      SECRET,
    );
    expect(out).not.toContain("a.example");
    expect(out).toContain("1x");
    expect(out).toContain("2x");
  });

  it("proxies CSS url() in an inline style attribute", async () => {
    const out = await proxyRemoteContent(
      `<div style="background-image:url(https://tracker.example/bg.png)"></div>`,
      SECRET,
    );
    expect(out).not.toContain("tracker.example");
    expect(out).toContain("/api/messages/proxy-image?u=");
  });

  it("proxies CSS url() inside a <style> block", async () => {
    const out = await proxyRemoteContent(
      `<style>.x{background:url("https://tracker.example/p.gif")}</style>`,
      SECRET,
    );
    expect(out).not.toContain("tracker.example");
    expect(out).toContain("/api/messages/proxy-image?u=");
  });

  it("strips @import (a remote-stylesheet tracking vector)", async () => {
    const out = await proxyRemoteContent(
      `<style>@import url(https://tracker.example/x.css);.y{color:red}</style>`,
      SECRET,
    );
    expect(out).not.toContain("tracker.example");
    expect(out).not.toContain("@import");
    expect(out).toContain("color:red");
  });

  it("proxies the legacy background attribute", async () => {
    const out = await proxyRemoteContent(
      `<table background="https://tracker.example/t.gif"></table>`,
      SECRET,
    );
    expect(out).not.toContain("tracker.example");
    expect(out).toContain("/api/messages/proxy-image?u=");
  });
});

describe("verifyProxyUrl", () => {
  it("rejects a tampered signature", async () => {
    const out = await proxyRemoteContent('<img src="https://x.example/a.png">', SECRET);
    const { u } = paramsOf(out);
    expect(await verifyProxyUrl(SECRET, decodeURIComponent(u), "deadbeef")).toBeNull();
  });

  it("rejects a different secret", async () => {
    const out = await proxyRemoteContent('<img src="https://x.example/a.png">', SECRET);
    const { u, s } = paramsOf(out);
    expect(await verifyProxyUrl("other", decodeURIComponent(u), decodeURIComponent(s))).toBeNull();
  });
});

describe("isBlockedHost", () => {
  it("blocks loopback, private, link-local and internal names", () => {
    for (const h of [
      "localhost",
      "foo.internal",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.5.5",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it("blocks loopback/private in non-decimal IPv4 encodings", () => {
    for (const h of [
      "2130706433", // 127.0.0.1 as a single decimal
      "0x7f000001", // hex
      "0177.0.0.1", // octal first octet
      "127.1", // short form
      "127.0.1", // 3-part short form
      "::ffff:127.0.0.1", // IPv4-mapped IPv6
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "::", // unspecified
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const h of [
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "2606:4700::1111",
      "16843009", // 1.1.1.1 as a single decimal — public, must pass
    ]) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });
});
