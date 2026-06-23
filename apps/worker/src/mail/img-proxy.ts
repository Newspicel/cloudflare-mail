// Remote-image proxying for rendered message bodies. Email HTML routinely
// embeds `<img>` tags pointing at sender-controlled hosts; loading them
// directly leaks the reader's IP/User-Agent (tracking pixels) and read status.
// Instead the `/body` endpoint rewrites every remote image to a same-origin
// proxy URL signed with the instance auth secret, and `/proxy-image` fetches it
// server-side. The HMAC means we only ever fetch URLs we ourselves emitted
// (no open proxy); host checks below blunt SSRF against internal addresses.

const PROXY_PATH = "/api/messages/proxy-image";

// ─── base64url (URL-safe, unpadded) ─────────────────────────────────────────

function bytesToB64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64url(str: string): string {
  return bytesToB64url(new TextEncoder().encode(str).buffer as ArrayBuffer);
}

export function b64urlToStr(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── HMAC signing ───────────────────────────────────────────────────────────

async function sign(secret: string, url: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url));
  return bytesToB64url(sig);
}

/** Constant-time string compare to avoid leaking the signature byte-by-byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyProxyUrl(
  secret: string,
  encodedUrl: string,
  sig: string,
): Promise<string | null> {
  let url: string;
  try {
    url = b64urlToStr(encodedUrl);
  } catch {
    return null;
  }
  const expected = await sign(secret, url);
  return timingSafeEqual(expected, sig) ? url : null;
}

// ─── HTML rewriting ─────────────────────────────────────────────────────────

async function toProxyUrl(secret: string, raw: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // relative / malformed — leave untouched
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const sig = await sign(secret, raw);
  return `${PROXY_PATH}?u=${encodeURIComponent(strToB64url(raw))}&s=${encodeURIComponent(sig)}`;
}

// A srcset is `url descriptor, url descriptor, …`; rewrite each candidate URL.
async function rewriteSrcset(secret: string, srcset: string): Promise<string> {
  const parts = await Promise.all(
    srcset.split(",").map(async (candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return null;
      const [url, ...rest] = trimmed.split(/\s+/);
      if (!url) return null;
      const proxied = await toProxyUrl(secret, url);
      return [proxied ?? url, ...rest].join(" ");
    }),
  );
  return parts.filter(Boolean).join(", ");
}

// Matches `url( … )` in CSS — both `url(http://x)` and `url("http://x")`.
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
// `@import` pulls in a remote stylesheet — a tracking vector with no legit use
// in a sanitized mail body. Strip the whole rule rather than try to proxy it.
const CSS_IMPORT_RE = /@import[^;]+;/gi;

/**
 * Rewrite remote URLs inside a CSS string (a `style` attribute or a `<style>`
 * block) so background images and the like load through the proxy. Drops
 * `@import` outright. Relative/`data:` URLs are left untouched.
 */
async function rewriteCss(secret: string, css: string): Promise<string> {
  const cleaned = css.replace(CSS_IMPORT_RE, "");
  const urls = new Set<string>();
  for (const m of cleaned.matchAll(CSS_URL_RE)) if (m[2]) urls.add(m[2]);
  if (urls.size === 0) return cleaned;
  const map = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (u) => {
      const proxied = await toProxyUrl(secret, u.trim());
      if (proxied) map.set(u, proxied);
    }),
  );
  return cleaned.replace(CSS_URL_RE, (full, _q, u) => {
    const proxied = map.get(u);
    return proxied ? `url("${proxied}")` : full;
  });
}

/**
 * Route every remote-content vector in a parsed HTML body through the signed
 * proxy: `<img>` `src`/`srcset`, the legacy `background` attribute, and CSS
 * `url(…)` in both inline `style` attributes and `<style>` blocks. Combined
 * with the client-side sanitizer's tag/attr allowlist, this leaves the proxy
 * as the *only* way an email can fetch a remote resource — no tracking pixels.
 * Uses the native Workers HTMLRewriter so we never load the markup into a DOM.
 */
export async function proxyRemoteContent(html: string, secret: string): Promise<string> {
  let styleBuf = "";
  const res = new HTMLRewriter()
    .on("img", {
      async element(el) {
        const src = el.getAttribute("src");
        if (src) {
          const proxied = await toProxyUrl(secret, src);
          if (proxied) el.setAttribute("src", proxied);
        }
        const srcset = el.getAttribute("srcset");
        if (srcset) el.setAttribute("srcset", await rewriteSrcset(secret, srcset));
      },
    })
    .on("*", {
      async element(el) {
        const style = el.getAttribute("style");
        if (style?.includes("url(")) el.setAttribute("style", await rewriteCss(secret, style));
        const bg = el.getAttribute("background");
        if (bg) {
          const proxied = await toProxyUrl(secret, bg);
          if (proxied) el.setAttribute("background", proxied);
        }
      },
    })
    .on("style", {
      // Text arrives in chunks; buffer the whole node, then rewrite once.
      async text(chunk) {
        styleBuf += chunk.text;
        if (chunk.lastInTextNode) {
          const rewritten = await rewriteCss(secret, styleBuf);
          styleBuf = "";
          chunk.replace(rewritten, { html: true });
        } else {
          chunk.remove();
        }
      },
    })
    .transform(new Response(html));
  return await res.text();
}

// ─── SSRF guard ─────────────────────────────────────────────────────────────

// The SSRF host guard lives in `../ssrf.ts` so the push validator shares it.
export { isBlockedHost, safeRedirectFetch } from "../ssrf.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
