import { createMimeMessage } from "mimetext";
import PostalMime, { type Email as ParsedEmail } from "postal-mime";

export type { ParsedEmail };

export async function parseMime(raw: ArrayBuffer | string | ReadableStream): Promise<ParsedEmail> {
  return await PostalMime.parse(raw);
}

export async function streamToArrayBuffer(
  stream: ReadableStream<Uint8Array>,
  maxSize: number,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxSize) throw new Error(`message exceeds max size ${maxSize}`);
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

export interface ThreadingHeaders {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

export function buildThreadingHeaders(input: ThreadingHeaders): Record<string, string> {
  const headers: Record<string, string> = { "Message-ID": input.messageId };
  if (input.inReplyTo) headers["In-Reply-To"] = input.inReplyTo;
  if (input.references?.length) headers.References = input.references.join(" ");
  return headers;
}

export interface BuildMimeInput extends ThreadingHeaders {
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  bcc?: { name?: string; address: string }[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: {
    filename: string;
    contentType: string;
    data: Uint8Array;
  }[];
}

export function buildMime(input: BuildMimeInput): string {
  const msg = createMimeMessage();
  msg.setSender({ name: input.from.name ?? "", addr: input.from.address });
  msg.setRecipients(input.to.map((r) => ({ name: r.name ?? "", addr: r.address })));
  if (input.cc?.length) {
    msg.setCc(input.cc.map((r) => ({ name: r.name ?? "", addr: r.address })));
  }
  if (input.bcc?.length) {
    msg.setBcc(input.bcc.map((r) => ({ name: r.name ?? "", addr: r.address })));
  }
  msg.setSubject(input.subject);
  for (const [name, value] of Object.entries(buildThreadingHeaders(input))) {
    msg.setHeader(name, value);
  }

  if (input.text) msg.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) msg.addMessage({ contentType: "text/html", data: input.html });

  for (const att of input.attachments ?? []) {
    msg.addAttachment({
      filename: att.filename,
      contentType: att.contentType,
      data: uint8ToBase64(att.data),
      encoding: "base64",
    });
  }

  return msg.asRaw();
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function normalizeSubject(subject: string): string {
  return subject
    .trim()
    .replace(/^(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i, "")
    .toLowerCase();
}

export function snippet(body: string, len = 180): string {
  return body.replace(/\s+/g, " ").trim().slice(0, len);
}
