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

/**
 * Rewrite remote `<img>` sources in a parsed HTML body to signed proxy URLs.
 * Uses the native Workers HTMLRewriter so we never load the markup into a DOM.
 */
export async function proxyImages(html: string, secret: string): Promise<string> {
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
    .transform(new Response(html));
  return await res.text();
}

// ─── SSRF guard ─────────────────────────────────────────────────────────────

/** Best-effort block of internal/reserved targets for IP-literal/internal hosts. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (h.includes(":")) {
    // IPv6: loopback, link-local, unique-local.
    return h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd");
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // any-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
