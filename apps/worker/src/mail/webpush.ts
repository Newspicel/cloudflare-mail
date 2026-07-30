// Web Push request builder — RFC 8291 (aes128gcm encryption) + RFC 8292 (VAPID).
// Hand-rolled because every WebCrypto push library on npm (pushforge, block65,
// webpush-webcrypto) still emits the legacy draft-04 "aesgcm" scheme, which
// Apple's push service rejects — iOS devices silently never received pushes.
// aes128gcm is the standard all push services accept.

import { bytesToB64url } from "../lib/encoding.ts";

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  len: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

async function vapidJwt(privateJWK: string, aud: string, sub: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateJWK) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = (o: unknown) => bytesToB64url(utf8(JSON.stringify(o)).buffer as ArrayBuffer);
  const head = enc({ typ: "JWT", alg: "ES256" });
  // Must stay under 24h or push services reject the JWT with 403.
  const payload = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(`${head}.${payload}`) as BufferSource,
  );
  return `${head}.${payload}.${bytesToB64url(sig)}`;
}

export async function buildPushRequest(opts: {
  privateJWK: string;
  /** b64url raw P-256 point — the applicationServerKey browsers subscribed with. */
  publicKey: string;
  subscription: WebPushSubscription;
  payload: unknown;
  ttl: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  adminContact: string;
}): Promise<WebPushRequest> {
  const clientPub = b64urlToBytes(opts.subscription.keys.p256dh);
  const authSecret = b64urlToBytes(opts.subscription.keys.auth);

  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ephPub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer,
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types spells the field `$public` (typegen artifact); the runtime
      // takes the standard `public`. This file also compiles under lib.dom via
      // the web app, so derive the param type instead of naming either variant.
      { name: "ECDH", public: clientKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0],
      eph.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3–3.4: auth-secret-keyed extract, then per-message salt.
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(utf8("WebPush: info\0"), clientPub, ephPub),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // RFC 8188 single record: payload + 0x02 last-record delimiter.
  const record = concat(utf8(JSON.stringify(opts.payload)), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aes,
      record as BufferSource,
    ),
  );

  // aes128gcm body header: salt | rs (u32be) | idlen | keyid (ephemeral pub).
  const header = new Uint8Array(16 + 4 + 1 + ephPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = ephPub.length;
  header.set(ephPub, 21);
  const body = concat(header, ciphertext);

  const jwt = await vapidJwt(
    opts.privateJWK,
    new URL(opts.subscription.endpoint).origin,
    opts.adminContact,
  );
  return {
    endpoint: opts.subscription.endpoint,
    headers: {
      authorization: `vapid t=${jwt}, k=${opts.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(opts.ttl),
      ...(opts.urgency ? { urgency: opts.urgency } : {}),
    },
    body: body.buffer as ArrayBuffer,
  };
}
