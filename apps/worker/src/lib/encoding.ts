// Shared byte/string encoding helpers used across config, auth tokens, push and
// the image proxy.

function bytesToBinary(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Standard base64 of `byteLen` random bytes. */
export function randomBase64(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return btoa(bytesToBinary(bytes));
}

/** URL-safe base64 token from `byteLen` random bytes (32 = 256 bits). */
export function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToB64url(bytes.buffer);
}

/** URL-safe, unpadded base64 of a buffer. */
export function bytesToB64url(buf: ArrayBuffer): string {
  return btoa(bytesToBinary(new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
