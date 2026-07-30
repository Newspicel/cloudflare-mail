import { describe, expect, it } from "vitest";
import { bytesToB64url } from "../src/lib/encoding.ts";
import { buildPushRequest } from "../src/mail/webpush.ts";

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
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      key,
      len * 8,
    ),
  );
}

// A "browser": ECDH subscription keypair + 16-byte auth secret, exposed the way
// PushSubscription.toJSON() would hand them to the server.
async function makeBrowser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    p256dh: bytesToB64url(pubRaw.buffer as ArrayBuffer),
    auth: bytesToB64url(auth.buffer as ArrayBuffer),
  };
}

// Server VAPID keys, mirroring getOrCreateVapid's storage format.
async function makeVapid() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const rawPub = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return {
    publicKey: bytesToB64url(rawPub),
    privateJWK: JSON.stringify({ alg: "ES256", ...jwk }),
    verifyKey: pair.publicKey,
  };
}

// RFC 8291 §3.4 decryption, the inverse a push client performs.
async function decrypt(body: ArrayBuffer, browser: Awaited<ReturnType<typeof makeBrowser>>) {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const rs = new DataView(body).getUint32(16);
  const idlen = bytes[20]!;
  const ephPub = bytes.slice(21, 21 + idlen);
  const ciphertext = bytes.slice(21 + idlen);

  const ephKey = await crypto.subtle.importKey(
    "raw",
    ephPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types spells the field `$public`; the runtime takes `public`.
      { name: "ECDH", public: ephKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0],
      browser.privateKey,
      256,
    ),
  );
  const clientPub = b64urlToBytes(browser.p256dh);
  const ikm = await hkdf(
    b64urlToBytes(browser.auth),
    secret,
    concat(utf8("WebPush: info\0"), clientPub, ephPub),
    32,
  );
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aes,
      ciphertext as BufferSource,
    ),
  );
  // Strip the 0x02 last-record delimiter and any trailing padding.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  expect(record[end]).toBe(2);
  return { rs, idlen, text: new TextDecoder().decode(record.slice(0, end)) };
}

describe("buildPushRequest", () => {
  it("emits aes128gcm a push client can decrypt, with a valid VAPID JWT", async () => {
    const browser = await makeBrowser();
    const vapid = await makeVapid();
    const payload = { title: "sender", body: "subject", url: "/app/m/1/t/2", threadId: "t2" };

    const req = await buildPushRequest({
      privateJWK: vapid.privateJWK,
      publicKey: vapid.publicKey,
      subscription: {
        endpoint: "https://web.push.apple.com/QOZaNZTPa",
        keys: { p256dh: browser.p256dh, auth: browser.auth },
      },
      payload,
      ttl: 12 * 60 * 60,
      urgency: "high",
      adminContact: "mailto:push@cfmail.invalid",
    });

    // Apple rejects the legacy "aesgcm" scheme — the encoding must be aes128gcm
    // with no draft-04 Encryption/Crypto-Key headers.
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(req.headers.encryption).toBeUndefined();
    expect(req.headers["crypto-key"]).toBeUndefined();
    expect(req.headers.ttl).toBe(String(12 * 60 * 60));
    expect(req.headers.urgency).toBe("high");

    const { rs, idlen, text } = await decrypt(req.body, browser);
    expect(rs).toBe(4096);
    expect(idlen).toBe(65);
    expect(JSON.parse(text)).toEqual(payload);

    // VAPID: `vapid t=<jwt>, k=<serverPub>`, ES256-signed, audience = endpoint origin.
    const m = req.headers.authorization?.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=(.+)$/);
    expect(m).toBeTruthy();
    const [, jwt, k] = m!;
    expect(k).toBe(vapid.publicKey);
    const [head, claims, sig] = jwt!.split(".");
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      vapid.verifyKey,
      b64urlToBytes(sig!) as BufferSource,
      utf8(`${head}.${claims}`) as BufferSource,
    );
    expect(verified).toBe(true);
    const decoded = JSON.parse(new TextDecoder().decode(b64urlToBytes(claims!)));
    expect(decoded.aud).toBe("https://web.push.apple.com");
    expect(decoded.sub).toBe("mailto:push@cfmail.invalid");
    expect(decoded.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
  });
});
