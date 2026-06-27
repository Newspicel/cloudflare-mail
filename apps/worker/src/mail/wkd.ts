// Web Key Directory (WKD) lookup — fetch a correspondent's public key straight
// from their mail provider by deriving a well-known HTTPS URL from their address
// (draft-koch-openpgp-webkey-service). Lets the gateway auto-import keys so
// encryption "just works" for WKD-enabled providers (Proton, mailbox.org, …)
// without the owner pasting anything. Best-effort: every failure returns null and
// callers must never block mail on it (invariant 8). Fetches go through the SSRF
// guard so a hostile domain can't point us at an internal address.

import { safeRedirectFetch } from "../ssrf.ts";
import { type PublicKeyInfo, readPublicKeyInfoBinary } from "./pgp.ts";

const WKD_TIMEOUT_MS = 4000;
const MAX_WKD_BYTES = 256 * 1024;

// Z-Base-32 (RFC 6189 §5.1.6) — WKD encodes the SHA-1 of the local part with it.
const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

function zbase32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31];
  return out;
}

async function localHash(localPart: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(localPart));
  return zbase32(new Uint8Array(digest));
}

// Fetch and validate a public key for `email` via WKD, trying the advanced layout
// (openpgpkey.<domain>) then the direct one (<domain>). Returns the parsed key
// only if it actually claims `email`; null otherwise.
export async function fetchWkdKey(email: string): Promise<PublicKeyInfo | null> {
  const addr = email.toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!local || !domain) return null;

  const hash = await localHash(local);
  const q = `?l=${encodeURIComponent(local)}`;
  const urls = [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}${q}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hash}${q}`,
  ];
  for (const url of urls) {
    const info = await tryUrl(url, addr);
    if (info) return info;
  }
  return null;
}

async function tryUrl(url: string, addr: string): Promise<PublicKeyInfo | null> {
  try {
    const res = await safeRedirectFetch(new URL(url), {
      headers: { accept: "application/octet-stream" },
      signal: AbortSignal.timeout(WKD_TIMEOUT_MS),
    });
    if ("blocked" in res) return null;
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_WKD_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_WKD_BYTES) return null;
    const info = await readPublicKeyInfoBinary(bytes);
    // Only trust a key that actually claims the address we looked up.
    return info.emails.includes(addr) ? info : null;
  } catch {
    return null;
  }
}
