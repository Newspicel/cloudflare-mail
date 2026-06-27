// Gateway PGP (OpenPGP) for per-mailbox sign/encrypt. The Worker holds each
// mailbox's private key (wrapped at rest, see config.ts#getOrCreatePgpMasterKey)
// and signs/encrypts outbound + decrypts/verifies inbound, so search/spam/
// threading keep working on plaintext. This is NOT end-to-end — the server can
// read mail. See CLAUDE.md invariant 17.
import type * as OpenPGP from "openpgp";

// openpgp is ~377 KB and PGP is opt-in per mailbox, so most isolates never run
// it. Load it lazily (cached) to keep it out of cold-start top-level eval.
let pgpModule: Promise<typeof import("openpgp")> | null = null;
function loadPgp(): Promise<typeof import("openpgp")> {
  if (!pgpModule) pgpModule = import("openpgp");
  return pgpModule;
}

const CRLF = "\r\n";

// ─── At-rest key wrapping (AES-GCM via WebCrypto) ───────────────────────────

// Import a 32-byte base64 master secret (from system_config) as an AES-GCM key.
export async function importMasterKey(base64Secret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Wrap a plaintext secret. Output is `base64(iv).base64(ciphertext)`.
export async function wrapSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function unwrapSecret(key: CryptoKey, blob: string): Promise<string> {
  const [ivB64, ctB64] = blob.split(".");
  if (!ivB64 || !ctB64) throw new Error("malformed wrapped secret");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ─── Keypair generation / import ────────────────────────────────────────────

export interface MailboxKeyMaterial {
  privateArmored: string;
  publicArmored: string;
  fingerprint: string;
  // Random passphrase the private key is encrypted under; stored wrapped too.
  passphrase: string;
}

function newPassphrase(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generateKeypair(name: string, email: string): Promise<MailboxKeyMaterial> {
  const openpgp = await loadPgp();
  const passphrase = newPassphrase();
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "curve25519",
    userIDs: [{ name: name || email, email }],
    passphrase,
    format: "armored",
  });
  const pub = await openpgp.readKey({ armoredKey: publicKey });
  return {
    privateArmored: privateKey,
    publicArmored: publicKey,
    fingerprint: pub.getFingerprint(),
    passphrase,
  };
}

// Validate an imported armored private key and normalise it: decrypt with the
// caller's passphrase (if any), then re-encrypt under a fresh random passphrase
// so storage is uniform regardless of how the key was protected on import.
export async function importPrivateKey(
  armored: string,
  passphrase?: string,
): Promise<MailboxKeyMaterial> {
  const openpgp = await loadPgp();
  let priv = await openpgp.readPrivateKey({ armoredKey: armored });
  if (!priv.isDecrypted()) {
    if (!passphrase) throw new Error("private key is passphrase-protected");
    priv = await openpgp.decryptKey({ privateKey: priv, passphrase });
  }
  const newPass = newPassphrase();
  const reenc = await openpgp.encryptKey({ privateKey: priv, passphrase: newPass });
  const privateArmored = reenc.armor();
  const publicArmored = priv.toPublic().armor();
  return { privateArmored, publicArmored, fingerprint: priv.getFingerprint(), passphrase: newPass };
}

export interface PublicKeyInfo {
  publicArmored: string;
  fingerprint: string;
  emails: string[];
  // Key expiry as epoch ms, or null when the key never expires.
  expiresAt: number | null;
}

// Parse an armored public key for the contact-key store.
export async function readPublicKeyInfo(armored: string): Promise<PublicKeyInfo> {
  const openpgp = await loadPgp();
  return keyInfo(await openpgp.readKey({ armoredKey: armored }));
}

// Same, from a binary key (e.g. a WKD response body, which is not armored).
export async function readPublicKeyInfoBinary(bytes: Uint8Array): Promise<PublicKeyInfo> {
  const openpgp = await loadPgp();
  return keyInfo(await openpgp.readKey({ binaryKey: bytes }));
}

async function keyInfo(key: OpenPGP.Key): Promise<PublicKeyInfo> {
  if (key.isPrivate()) throw new Error("expected a public key, got a private key");
  const emails = key
    .getUserIDs()
    .map(
      (uid) =>
        uid
          .match(/<([^>]+)>/)?.[1]
          ?.toLowerCase()
          .trim() ?? uid.toLowerCase().trim(),
    )
    .filter(Boolean);
  return {
    publicArmored: key.armor(),
    fingerprint: key.getFingerprint(),
    emails,
    expiresAt: await keyExpiry(key),
  };
}

// openpgp returns a Date, Infinity (never expires), or null (unknown). Normalise
// to epoch ms or null. Best-effort — any parse hiccup means "no known expiry".
async function keyExpiry(key: OpenPGP.Key): Promise<number | null> {
  try {
    const exp = await key.getExpirationTime();
    return exp instanceof Date ? exp.getTime() : null;
  } catch {
    return null;
  }
}

// ─── PGP detection on a received message ────────────────────────────────────

export interface PgpShape {
  encrypted: boolean;
  signed: boolean;
  // True for PGP/MIME (RFC 3156): the encrypted payload decrypts to a full MIME
  // entity that must be re-parsed. False for inline PGP, whose payload is bare
  // plaintext — parsing it as MIME is both wasteful and unsound.
  mime: boolean;
}

// Look at the raw .eml to classify PGP/MIME (RFC 3156) and inline PGP. postal-
// mime flattens signed/encrypted parts, so we inspect the raw bytes ourselves.
export function detectPgp(rawText: string): PgpShape {
  const { headers } = splitHeadersBody(rawText);
  const ct = (headerValue(headers, "content-type") ?? "").toLowerCase();
  if (ct.includes("multipart/encrypted") && ct.includes("application/pgp-encrypted")) {
    return { encrypted: true, signed: false, mime: true };
  }
  if (ct.includes("multipart/signed") && ct.includes("application/pgp-signature")) {
    return { encrypted: false, signed: true, mime: true };
  }
  // Inline PGP in the body.
  if (rawText.includes("-----BEGIN PGP MESSAGE-----"))
    return { encrypted: true, signed: false, mime: false };
  if (rawText.includes("-----BEGIN PGP SIGNED MESSAGE-----"))
    return { encrypted: false, signed: true, mime: false };
  return { encrypted: false, signed: false, mime: false };
}

// ─── Outbound: build signed / encrypted PGP/MIME ────────────────────────────

export interface MailContent {
  text?: string;
  html?: string;
  attachments?: {
    filename: string;
    contentType: string;
    data: Uint8Array;
    inline?: boolean;
    contentId?: string;
  }[];
}

export interface PgpHeaders {
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  bcc?: { name?: string; address: string }[];
  replyTo?: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  date: Date;
}

// multipart/signed (RFC 3156): the content entity is sent verbatim alongside a
// detached signature over its canonical (CRLF) form.
export async function buildSignedMime(
  hdrs: PgpHeaders,
  content: MailContent,
  privArmored: string,
  passphrase: string,
): Promise<string> {
  const openpgp = await loadPgp();
  const priv = await unlockPrivate(privArmored, passphrase);
  const entity = buildContentEntity(content);
  const detached = await openpgp.sign({
    message: await openpgp.createMessage({ text: entity }),
    signingKeys: [priv],
    detached: true,
    format: "armored",
  });
  const micalg = await signatureMicalg(detached);
  const boundary = randomBoundary("sig");
  const top = topHeaders(hdrs, {
    "Content-Type": `multipart/signed; micalg="${micalg}"; protocol="application/pgp-signature"; boundary="${boundary}"`,
  });
  return [
    top,
    "",
    `--${boundary}`,
    entity,
    `--${boundary}`,
    'Content-Type: application/pgp-signature; name="signature.asc"',
    "Content-Description: OpenPGP digital signature",
    'Content-Disposition: attachment; filename="signature.asc"',
    "",
    detached.trim(),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

// multipart/encrypted (RFC 3156): the content entity is sign+encrypted to all
// recipient keys (plus self) and carried as an opaque armored blob.
export async function buildEncryptedMime(
  hdrs: PgpHeaders,
  content: MailContent,
  privArmored: string,
  passphrase: string,
  recipientPublicKeys: string[],
): Promise<string> {
  const openpgp = await loadPgp();
  const priv = await unlockPrivate(privArmored, passphrase);
  const encryptionKeys = await Promise.all(
    recipientPublicKeys.map((k) => openpgp.readKey({ armoredKey: k })),
  );
  const entity = buildContentEntity(content);
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: entity }),
    encryptionKeys,
    signingKeys: [priv],
    format: "armored",
  });
  const boundary = randomBoundary("enc");
  const top = topHeaders(hdrs, {
    "Content-Type": `multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
  });
  return [
    top,
    "",
    `--${boundary}`,
    "Content-Type: application/pgp-encrypted",
    "Content-Description: PGP/MIME version identification",
    "",
    "Version: 1",
    "",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "Content-Description: OpenPGP encrypted message",
    'Content-Disposition: inline; filename="encrypted.asc"',
    "",
    (armored as string).trim(),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

// ─── Inbound: decrypt + verify ──────────────────────────────────────────────

export interface DecryptResult {
  encrypted: boolean;
  signed: boolean;
  verify: "good" | "bad" | "unknown" | null;
  signedBy: string | null;
  // The decrypted inner payload to re-index. Null when the message was
  // signed-only (nothing to substitute) or decryption failed.
  decryptedRaw: string | null;
  // True when `decryptedRaw` is a full MIME entity (PGP/MIME) needing a re-parse;
  // false when it's inline-PGP plaintext that should be used as the body verbatim.
  decryptedMime: boolean;
}

export async function decryptVerify(args: {
  rawText: string;
  privArmored: string;
  passphrase: string;
  senderPublicKey?: string | null;
}): Promise<DecryptResult> {
  const { rawText, privArmored, passphrase, senderPublicKey } = args;
  const openpgp = await loadPgp();
  const shape = detectPgp(rawText);
  const verificationKeys = await readVerificationKeys(senderPublicKey);
  const haveKey = verificationKeys.length > 0;

  if (shape.encrypted) {
    const armored = extractArmored(rawText, "MESSAGE");
    if (!armored) return failed(true, false);
    try {
      const priv = await unlockPrivate(privArmored, passphrase);
      const { data, signatures } = await openpgp.decrypt({
        message: await openpgp.readMessage({ armoredMessage: armored }),
        decryptionKeys: [priv],
        ...(haveKey ? { verificationKeys } : {}),
      });
      const v = await checkSignatures(signatures, haveKey);
      return {
        encrypted: true,
        signed: v.signed,
        verify: v.verify,
        signedBy: v.signedBy,
        decryptedRaw: typeof data === "string" ? data : null,
        decryptedMime: shape.mime,
      };
    } catch {
      return failed(true, false);
    }
  }

  if (shape.signed) {
    // Without the sender's public key we can't verify — record it as signed/unknown.
    if (!haveKey) {
      return {
        encrypted: false,
        signed: true,
        verify: "unknown",
        signedBy: null,
        decryptedRaw: null,
        decryptedMime: false,
      };
    }
    try {
      const { content, signature } = splitSignedParts(rawText);
      if (!content || !signature) {
        return {
          encrypted: false,
          signed: true,
          verify: "unknown",
          signedBy: null,
          decryptedRaw: null,
          decryptedMime: false,
        };
      }
      const vr = await openpgp.verify({
        message: await openpgp.createMessage({ text: content }),
        signature: await openpgp.readSignature({ armoredSignature: signature }),
        verificationKeys,
      });
      const v = await checkSignatures(vr.signatures, true);
      return {
        encrypted: false,
        signed: true,
        verify: v.verify,
        signedBy: v.signedBy,
        decryptedRaw: null,
        decryptedMime: false,
      };
    } catch {
      return {
        encrypted: false,
        signed: true,
        verify: "unknown",
        signedBy: null,
        decryptedRaw: null,
        decryptedMime: false,
      };
    }
  }

  return {
    encrypted: false,
    signed: false,
    verify: null,
    signedBy: null,
    decryptedRaw: null,
    decryptedMime: false,
  };
}

async function readVerificationKeys(armored?: string | null): Promise<OpenPGP.PublicKey[]> {
  if (!armored) return [];
  const openpgp = await loadPgp();
  try {
    return [(await openpgp.readKey({ armoredKey: armored })) as OpenPGP.PublicKey];
  } catch {
    return [];
  }
}

function failed(encrypted: boolean, signed: boolean): DecryptResult {
  return {
    encrypted,
    signed,
    verify: "unknown",
    signedBy: null,
    decryptedRaw: null,
    decryptedMime: false,
  };
}

async function checkSignatures(
  signatures: { keyID: { toHex(): string }; verified: Promise<boolean> }[],
  haveKey: boolean,
): Promise<{
  signed: boolean;
  verify: "good" | "bad" | "unknown" | null;
  signedBy: string | null;
}> {
  if (!signatures.length) return { signed: false, verify: null, signedBy: null };
  const signedBy = signatures[0]?.keyID.toHex() ?? null;
  if (!haveKey) return { signed: true, verify: "unknown", signedBy };
  try {
    await signatures[0]!.verified;
    return { signed: true, verify: "good", signedBy };
  } catch {
    return { signed: true, verify: "bad", signedBy };
  }
}

// ─── MIME construction helpers (CRLF, base64 — fully ASCII so signing is
//     canonical and binary attachments survive) ──────────────────────────────

function buildContentEntity(content: MailContent): string {
  const hasText = typeof content.text === "string";
  const hasHtml = typeof content.html === "string";
  let body: string;
  if (hasText && hasHtml) {
    const b = randomBoundary("alt");
    body = [
      `Content-Type: multipart/alternative; boundary="${b}"`,
      "",
      `--${b}`,
      textPart("text/plain", content.text ?? ""),
      `--${b}`,
      textPart("text/html", content.html ?? ""),
      `--${b}--`,
    ].join(CRLF);
  } else if (hasHtml) {
    body = textPart("text/html", content.html ?? "");
  } else {
    body = textPart("text/plain", content.text ?? "");
  }
  if (!content.attachments?.length) return body;
  const b = randomBoundary("mix");
  const lines = [`Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, body];
  for (const att of content.attachments) lines.push(`--${b}`, attachmentPart(att));
  lines.push(`--${b}--`);
  return lines.join(CRLF);
}

function textPart(contentType: string, text: string): string {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(new TextEncoder().encode(text)),
  ].join(CRLF);
}

function attachmentPart(att: {
  filename: string;
  contentType: string;
  data: Uint8Array;
  inline?: boolean;
  contentId?: string;
}): string {
  const name = mimeFilename(att.filename);
  const lines = [
    `Content-Type: ${att.contentType}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${att.inline ? "inline" : "attachment"}; filename="${name}"`,
  ];
  if (att.inline && att.contentId) {
    const bare = att.contentId.replace(/^<|>$/g, "");
    if (bare) lines.push(`Content-ID: <${bare}>`);
  }
  lines.push("", b64lines(att.data));
  return lines.join(CRLF);
}

function topHeaders(h: PgpHeaders, extra: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`From: ${formatAddr(h.from)}`);
  lines.push(`To: ${h.to.map(formatAddr).join(", ")}`);
  if (h.cc?.length) lines.push(`Cc: ${h.cc.map(formatAddr).join(", ")}`);
  if (h.replyTo) lines.push(`Reply-To: ${h.replyTo}`);
  lines.push(`Subject: ${encodeHeaderText(h.subject)}`);
  lines.push(`Date: ${h.date.toUTCString().replace(/GMT$/, "+0000")}`);
  lines.push(`Message-ID: ${h.messageId}`);
  if (h.inReplyTo) lines.push(`In-Reply-To: ${h.inReplyTo}`);
  if (h.references?.length) lines.push(`References: ${h.references.join(" ")}`);
  lines.push("MIME-Version: 1.0");
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
  return lines.join(CRLF);
}

async function unlockPrivate(armored: string, passphrase: string): Promise<OpenPGP.PrivateKey> {
  const openpgp = await loadPgp();
  const priv = await openpgp.readPrivateKey({ armoredKey: armored });
  if (priv.isDecrypted()) return priv;
  return openpgp.decryptKey({ privateKey: priv, passphrase });
}

async function signatureMicalg(armoredSig: string): Promise<string> {
  const openpgp = await loadPgp();
  const sig = await openpgp.readSignature({ armoredSignature: armoredSig });
  // biome-ignore lint/suspicious/noExplicitAny: signature packet shape isn't in the public types
  const algo = (sig.packets[0] as any)?.hashAlgorithm as number | undefined;
  const name = algo ? openpgp.enums.read(openpgp.enums.hash, algo) : "sha256";
  return `pgp-${name}`;
}

function formatAddr(a: { name?: string; address: string }): string {
  if (!a.name) return a.address;
  return `${encodeHeaderWord(a.name)} <${a.address}>`;
}

// RFC 2047 encode a display-name word if it has non-ASCII; otherwise quote if needed.
function encodeHeaderWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return /[",:;<>@]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  return encodeHeaderText(s);
}

function encodeHeaderText(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?utf-8?B?${b64(new TextEncoder().encode(s))}?=`;
}

function mimeFilename(name: string): string {
  let clean = "";
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || ch === '"' || ch === "\\") continue;
    clean += ch;
  }
  return clean.trim().slice(0, 200) || "attachment";
}

function randomBoundary(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `=_${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
}

function b64lines(bytes: Uint8Array): string {
  const s = b64(bytes);
  return s.match(/.{1,76}/g)?.join(CRLF) ?? s;
}

// ─── Raw MIME parsing for inbound PGP/MIME ──────────────────────────────────

function splitHeadersBody(raw: string): { headers: string; body: string } {
  const m = raw.search(/\r?\n\r?\n/);
  if (m === -1) return { headers: raw, body: "" };
  const sep = raw.slice(m).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
  return { headers: raw.slice(0, m), body: raw.slice(m + sep) };
}

function headerValue(headers: string, name: string): string | null {
  const lines = headers.split(/\r?\n/);
  const lower = name.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== lower) continue;
    let value = line.slice(colon + 1).trim();
    // Unfold continuation lines.
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]!)) {
      value += ` ${lines[++i]!.trim()}`;
    }
    return value;
  }
  return null;
}

function boundaryOf(contentType: string): string | null {
  return contentType.match(/boundary="?([^";]+)"?/i)?.[1] ?? null;
}

function splitParts(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const out: string[] = [];
  const segments = body.split(delim);
  for (const seg of segments) {
    if (seg === "" || seg.startsWith("--")) continue; // preamble / closing
    // Strip the leading CRLF after the boundary and the trailing CRLF before the next.
    out.push(seg.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }
  return out;
}

function extractArmored(
  raw: string,
  kind: "MESSAGE" | "SIGNATURE" | "PUBLIC KEY BLOCK",
): string | null {
  const begin = `-----BEGIN PGP ${kind}-----`;
  const end = `-----END PGP ${kind}-----`;
  const i = raw.indexOf(begin);
  const j = raw.indexOf(end);
  if (i === -1 || j === -1) return null;
  return raw.slice(i, j + end.length);
}

// Pull an armored public key out of a raw message (attached or inline), for TOFU
// capture of a correspondent's key.
export function extractPublicKeyBlock(rawText: string): string | null {
  return extractArmored(rawText, "PUBLIC KEY BLOCK");
}

// For multipart/signed: return the exact bytes of the signed content part and
// the armored detached signature.
function splitSignedParts(raw: string): { content: string | null; signature: string | null } {
  const { headers, body } = splitHeadersBody(raw);
  const ct = headerValue(headers, "content-type") ?? "";
  const boundary = boundaryOf(ct);
  if (!boundary) return { content: null, signature: null };
  const parts = splitParts(body, boundary);
  const content = parts[0] ?? null;
  const sigPart = parts.find((p) => p.includes("-----BEGIN PGP SIGNATURE-----"));
  const signature = sigPart ? extractArmored(sigPart, "SIGNATURE") : null;
  return { content, signature };
}
