// Builds the quoted-original block appended to a reply or forward. Resolved
// server-side from the original message's raw `.eml` so the quote keeps its
// real remote image URLs (the rendered `/body` rewrites those to same-origin
// proxy paths, which would be dead links for the recipient). The HTML/text are
// concatenated onto the composed body in `sendFromMailbox`.

import type { DB } from "@cfmail/db";
import { message } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { escapeHtml } from "../lib/encoding.ts";
import { requirePerm } from "../permissions.ts";
import { parseMime } from "./mime.ts";

export interface QuoteRef {
  messageId: string;
  kind: "reply" | "forward";
}

export interface BuiltQuote {
  html: string;
  text: string;
}

export async function buildQuote(
  env: Env,
  db: DB,
  userId: string,
  ref: QuoteRef,
): Promise<BuiltQuote | undefined> {
  const orig = await db.query.message.findFirst({
    where: eq(message.id, ref.messageId),
    columns: {
      mailboxId: true,
      rawR2Key: true,
      fromName: true,
      fromAddr: true,
      subject: true,
      sentAt: true,
      receivedAt: true,
      createdAt: true,
      toAddrs: true,
      ccAddrs: true,
    },
  });
  if (!orig) return undefined;
  await requirePerm(db, userId, orig.mailboxId, Perm.READ);

  let origHtml: string | null = null;
  let origText: string | null = null;
  if (orig.rawR2Key) {
    const obj = await env.BLOBS.get(orig.rawR2Key);
    if (obj) {
      const parsed = await parseMime(await obj.arrayBuffer());
      origHtml = parsed.html ?? null;
      origText = parsed.text ?? null;
    }
  }

  const when = new Date(orig.sentAt ?? orig.receivedAt ?? orig.createdAt).toUTCString();
  const from = orig.fromName ? `${orig.fromName} <${orig.fromAddr}>` : orig.fromAddr;
  const bodyHtml = origHtml ?? textToHtml(origText ?? "");
  const bodyText = origText ?? stripHtml(origHtml ?? "");

  if (ref.kind === "reply") {
    const intro = `On ${when}, ${from} wrote:`;
    const html =
      `<div class="cfmail-quote">` +
      `<p style="margin:1em 0 8px;color:#6b7280;">${escapeHtml(intro)}</p>` +
      `<blockquote style="margin:0;padding-left:12px;border-left:2px solid #d1d5db;color:#4b5563;">${bodyHtml}</blockquote>` +
      `</div>`;
    const text = `\n\n${intro}\n${quotePlain(bodyText)}`;
    return { html, text };
  }

  const to = (orig.toAddrs ?? []).map((a) => a.address).join(", ");
  const cc = (orig.ccAddrs ?? []).map((a) => a.address).join(", ");
  const headerLines = [
    "---------- Forwarded message ----------",
    `From: ${from}`,
    `Date: ${when}`,
    `Subject: ${orig.subject}`,
    to ? `To: ${to}` : null,
    cc ? `Cc: ${cc}` : null,
  ].filter((l): l is string => l !== null);
  const html =
    `<div class="cfmail-forward">` +
    `<p style="margin:1em 0 8px;color:#6b7280;">${headerLines.map(escapeHtml).join("<br>")}</p>` +
    bodyHtml +
    `</div>`;
  const text = `\n\n${headerLines.join("\n")}\n\n${bodyText}`;
  return { html, text };
}

function quotePlain(s: string): string {
  return s
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
