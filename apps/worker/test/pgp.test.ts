import * as openpgp from "openpgp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildEncryptedMime,
  buildSignedMime,
  decryptVerify,
  detectPgp,
  extractPublicKeyBlock,
  generateKeypair,
  importMasterKey,
  importPrivateKey,
  type MailboxKeyMaterial,
  type PgpHeaders,
  readPublicKeyInfo,
  readPublicKeyInfoBinary,
  unwrapSecret,
  wrapSecret,
} from "../src/mail/pgp.ts";

// A random 32-byte master secret, base64-encoded (as stored in system_config).
function masterSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const x of raw) bin += String.fromCharCode(x);
  return btoa(bin);
}

// Decode every base64 body chunk in a MIME entity and concatenate the text, so
// tests can assert on the plaintext that buildContentEntity wrapped in base64.
function decodeBase64Body(entity: string): string {
  let out = "";
  for (const block of entity.split(/Content-Transfer-Encoding: base64\r?\n\r?\n/).slice(1)) {
    const b64 = block.split(/\r?\n--/)[0]!.replace(/\r?\n/g, "");
    try {
      out += new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      // skip non-decodable trailing markers
    }
  }
  return out;
}

// Keypair generation is the slow part; share one across the suite.
let alice: MailboxKeyMaterial;
let bob: MailboxKeyMaterial;

beforeAll(async () => {
  [alice, bob] = await Promise.all([
    generateKeypair("Alice", "alice@example.com"),
    generateKeypair("", "bob@example.com"),
  ]);
}, 30_000);

function headers(overrides: Partial<PgpHeaders> = {}): PgpHeaders {
  return {
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ address: "bob@example.com" }],
    subject: "Hello",
    messageId: "<msg-1@example.com>",
    date: new Date("2026-01-02T03:04:05Z"),
    ...overrides,
  };
}

describe("master key wrapping", () => {
  it("round-trips a secret through wrap/unwrap", async () => {
    const key = await importMasterKey(masterSecret());
    const wrapped = await wrapSecret(key, "super-secret-passphrase");
    expect(wrapped).toMatch(/^[^.]+\.[^.]+$/);
    expect(wrapped).not.toContain("super-secret-passphrase");
    expect(await unwrapSecret(key, wrapped)).toBe("super-secret-passphrase");
  });

  it("uses a fresh IV each time so ciphertexts differ", async () => {
    const key = await importMasterKey(masterSecret());
    const a = await wrapSecret(key, "same");
    const b = await wrapSecret(key, "same");
    expect(a).not.toBe(b);
    expect(await unwrapSecret(key, a)).toBe("same");
    expect(await unwrapSecret(key, b)).toBe("same");
  });

  it("preserves unicode payloads", async () => {
    const key = await importMasterKey(masterSecret());
    const wrapped = await wrapSecret(key, "schlüssel — 🔑");
    expect(await unwrapSecret(key, wrapped)).toBe("schlüssel — 🔑");
  });

  it("rejects a malformed wrapped blob", async () => {
    const key = await importMasterKey(masterSecret());
    await expect(unwrapSecret(key, "not-a-blob")).rejects.toThrow("malformed wrapped secret");
  });

  it("fails to unwrap under a different master key", async () => {
    const k1 = await importMasterKey(masterSecret());
    const k2 = await importMasterKey(masterSecret());
    const wrapped = await wrapSecret(k1, "secret");
    await expect(unwrapSecret(k2, wrapped)).rejects.toThrow();
  });
});

describe("generateKeypair", () => {
  it("produces an armored, passphrase-protected keypair with a fingerprint", () => {
    expect(alice.privateArmored).toContain("BEGIN PGP PRIVATE KEY BLOCK");
    expect(alice.publicArmored).toContain("BEGIN PGP PUBLIC KEY BLOCK");
    expect(alice.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(alice.passphrase.length).toBeGreaterThan(0);
  });

  it("encrypts the private key under the generated passphrase", async () => {
    const priv = await openpgp.readPrivateKey({ armoredKey: alice.privateArmored });
    expect(priv.isDecrypted()).toBe(false);
    const unlocked = await openpgp.decryptKey({ privateKey: priv, passphrase: alice.passphrase });
    expect(unlocked.isDecrypted()).toBe(true);
  });

  it("falls back to the email as the user-id name when none is given", async () => {
    const info = await readPublicKeyInfo(bob.publicArmored);
    expect(info.emails).toContain("bob@example.com");
  });
});

describe("importPrivateKey", () => {
  it("normalises a decrypted key under a fresh passphrase", async () => {
    const { privateKey } = await openpgp.generateKey({
      type: "curve25519",
      userIDs: [{ name: "Carol", email: "carol@example.com" }],
      format: "armored",
    });
    const material = await importPrivateKey(privateKey);
    expect(material.passphrase.length).toBeGreaterThan(0);
    const reread = await openpgp.readPrivateKey({ armoredKey: material.privateArmored });
    expect(reread.isDecrypted()).toBe(false);
    await expect(
      openpgp.decryptKey({ privateKey: reread, passphrase: material.passphrase }),
    ).resolves.toBeDefined();
    expect(material.publicArmored).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  });

  it("decrypts a passphrase-protected key before re-wrapping", async () => {
    const { privateKey } = await openpgp.generateKey({
      type: "curve25519",
      userIDs: [{ name: "Dave", email: "dave@example.com" }],
      passphrase: "original-pass",
      format: "armored",
    });
    const material = await importPrivateKey(privateKey, "original-pass");
    expect(material.passphrase).not.toBe("original-pass");
    expect(material.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects a passphrase-protected key when no passphrase is supplied", async () => {
    const { privateKey } = await openpgp.generateKey({
      type: "curve25519",
      userIDs: [{ name: "Eve", email: "eve@example.com" }],
      passphrase: "locked",
      format: "armored",
    });
    await expect(importPrivateKey(privateKey)).rejects.toThrow("passphrase-protected");
  });
});

describe("readPublicKeyInfo", () => {
  it("extracts emails, fingerprint, and expiry", async () => {
    const info = await readPublicKeyInfo(alice.publicArmored);
    expect(info.fingerprint).toBe(alice.fingerprint);
    expect(info.emails).toEqual(["alice@example.com"]);
    expect(info.expiresAt).toBeNull(); // generated keys never expire
    expect(info.publicArmored).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  });

  it("rejects a private key", async () => {
    await expect(readPublicKeyInfo(alice.privateArmored)).rejects.toThrow("expected a public key");
  });

  it("reads a binary (dearmored) public key", async () => {
    const key = await openpgp.readKey({ armoredKey: alice.publicArmored });
    const info = await readPublicKeyInfoBinary(key.write());
    expect(info.fingerprint).toBe(alice.fingerprint);
    expect(info.emails).toEqual(["alice@example.com"]);
  });
});

describe("detectPgp", () => {
  it("detects PGP/MIME encrypted", () => {
    const raw = [
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
      "",
      "--b",
      "Content-Type: application/pgp-encrypted",
      "",
      "Version: 1",
      "--b--",
    ].join("\r\n");
    expect(detectPgp(raw)).toEqual({ encrypted: true, signed: false, mime: true });
  });

  it("detects PGP/MIME signed", () => {
    const raw = [
      'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"',
      "",
      "--b--",
    ].join("\r\n");
    expect(detectPgp(raw)).toEqual({ encrypted: false, signed: true, mime: true });
  });

  it("detects inline encrypted PGP", () => {
    const raw =
      "Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nx\r\n-----END PGP MESSAGE-----";
    expect(detectPgp(raw)).toEqual({ encrypted: true, signed: false, mime: false });
  });

  it("detects inline signed PGP", () => {
    const raw =
      "Content-Type: text/plain\r\n\r\n-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA256\r\n\r\nhi";
    expect(detectPgp(raw)).toEqual({ encrypted: false, signed: true, mime: false });
  });

  it("returns all-false for plain mail", () => {
    expect(detectPgp("Content-Type: text/plain\r\n\r\nhello")).toEqual({
      encrypted: false,
      signed: false,
      mime: false,
    });
  });
});

describe("extractPublicKeyBlock", () => {
  it("pulls an armored public key out of raw text", () => {
    const raw = `Some preamble\r\n${alice.publicArmored}\r\ntrailing`;
    const block = extractPublicKeyBlock(raw);
    expect(block).toContain("BEGIN PGP PUBLIC KEY BLOCK");
    expect(block).toContain("END PGP PUBLIC KEY BLOCK");
  });

  it("returns null when there is no key block", () => {
    expect(extractPublicKeyBlock("just text")).toBeNull();
  });
});

describe("buildSignedMime + decryptVerify", () => {
  it("produces a verifiable multipart/signed message", async () => {
    const mime = await buildSignedMime(
      headers(),
      { text: "Signed hello" },
      alice.privateArmored,
      alice.passphrase,
    );
    expect(mime).toContain("multipart/signed");
    expect(mime).toContain('protocol="application/pgp-signature"');
    expect(mime).toContain("BEGIN PGP SIGNATURE");
    expect(detectPgp(mime)).toMatchObject({ signed: true, mime: true });

    const res = await decryptVerify({
      rawText: mime,
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
      senderPublicKey: alice.publicArmored,
    });
    expect(res).toMatchObject({ encrypted: false, signed: true, verify: "good" });
    expect(res.signedBy).toBeTruthy();
  });

  it("reports unknown when the sender key is absent", async () => {
    const mime = await buildSignedMime(
      headers(),
      { text: "Signed hello" },
      alice.privateArmored,
      alice.passphrase,
    );
    const res = await decryptVerify({
      rawText: mime,
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
    });
    expect(res).toMatchObject({ signed: true, verify: "unknown", signedBy: null });
  });

  it("reports bad when verified against the wrong key", async () => {
    const mime = await buildSignedMime(
      headers(),
      { text: "Signed hello" },
      alice.privateArmored,
      alice.passphrase,
    );
    const res = await decryptVerify({
      rawText: mime,
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
      senderPublicKey: bob.publicArmored,
    });
    expect(res).toMatchObject({ signed: true, verify: "bad" });
  });
});

describe("buildEncryptedMime + decryptVerify", () => {
  it("round-trips an encrypted+signed message", async () => {
    const mime = await buildEncryptedMime(
      headers(),
      { text: "Top secret", html: "<p>Top secret</p>" },
      alice.privateArmored,
      alice.passphrase,
      [alice.publicArmored],
    );
    expect(mime).toContain("multipart/encrypted");
    expect(mime).toContain("Version: 1");
    expect(mime).toContain("BEGIN PGP MESSAGE");
    expect(detectPgp(mime)).toMatchObject({ encrypted: true, mime: true });

    const res = await decryptVerify({
      rawText: mime,
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
      senderPublicKey: alice.publicArmored,
    });
    expect(res).toMatchObject({
      encrypted: true,
      signed: true,
      verify: "good",
      decryptedMime: true,
    });
    // The decrypted payload is a full MIME entity (base64-encoded bodies).
    expect(res.decryptedRaw).toContain("multipart/alternative");
    expect(decodeBase64Body(res.decryptedRaw!)).toContain("Top secret");
  });

  it("decrypts but cannot verify without the sender key", async () => {
    const mime = await buildEncryptedMime(
      headers(),
      { text: "Top secret" },
      alice.privateArmored,
      alice.passphrase,
      [alice.publicArmored],
    );
    const res = await decryptVerify({
      rawText: mime,
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
    });
    expect(res).toMatchObject({ encrypted: true, signed: true, verify: "unknown" });
    expect(decodeBase64Body(res.decryptedRaw!)).toContain("Top secret");
  });

  it("fails gracefully when decrypting with the wrong private key", async () => {
    const mime = await buildEncryptedMime(
      headers(),
      { text: "for alice only" },
      alice.privateArmored,
      alice.passphrase,
      [alice.publicArmored],
    );
    const res = await decryptVerify({
      rawText: mime,
      privArmored: bob.privateArmored,
      passphrase: bob.passphrase,
      senderPublicKey: alice.publicArmored,
    });
    expect(res).toMatchObject({ encrypted: true, decryptedRaw: null, verify: "unknown" });
  });

  it("encrypts to multiple recipients", async () => {
    const mime = await buildEncryptedMime(
      headers({ to: [{ address: "bob@example.com" }] }),
      { text: "shared" },
      alice.privateArmored,
      alice.passphrase,
      [alice.publicArmored, bob.publicArmored],
    );
    const res = await decryptVerify({
      rawText: mime,
      privArmored: bob.privateArmored,
      passphrase: bob.passphrase,
      senderPublicKey: alice.publicArmored,
    });
    expect(res).toMatchObject({ encrypted: true, verify: "good" });
    expect(decodeBase64Body(res.decryptedRaw!)).toContain("shared");
  });
});

describe("decryptVerify on non-PGP mail", () => {
  it("returns an all-null result", async () => {
    const res = await decryptVerify({
      rawText: "Content-Type: text/plain\r\n\r\nplain body",
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
    });
    expect(res).toEqual({
      encrypted: false,
      signed: false,
      verify: null,
      signedBy: null,
      decryptedRaw: null,
      decryptedMime: false,
    });
  });

  it("fails closed on an encrypted shape with no armored payload", async () => {
    const raw = [
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
      "",
      "--b",
      "Content-Type: application/pgp-encrypted",
      "",
      "Version: 1",
      "--b--",
    ].join("\r\n");
    const res = await decryptVerify({
      rawText: raw,
      privArmored: alice.privateArmored,
      passphrase: alice.passphrase,
    });
    expect(res).toMatchObject({ encrypted: true, decryptedRaw: null, verify: "unknown" });
  });
});
