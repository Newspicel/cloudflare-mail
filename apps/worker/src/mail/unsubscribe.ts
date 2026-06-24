// Acts on a message's RFC 2369/8058 unsubscribe headers. Three channels, in
// order of preference: an RFC 8058 one-click POST (fully server-side, only when
// the sender set List-Unsubscribe-Post), a mailto request sent as a real email
// from the mailbox, or — failing both — an https page handed back for the client
// to open (many are confirmation pages that can't be safely auto-submitted).

import type { DB } from "@cfmail/db";
import { domain, mailbox } from "@cfmail/db/schema";
import type { UnsubscribeResultDto } from "@cfmail/shared/responses";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.ts";
import { safeRedirectFetch } from "../ssrf.ts";

// Split "<mailto:...>, <https://...>" into its mailto and https targets. Other
// schemes (bare http:, etc.) are ignored — one-click mandates https and mailto
// is the only other channel we automate.
function parseTargets(header: string): { mailto?: string; https?: string } {
  const out: { mailto?: string; https?: string } = {};
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const uri = m[1]?.trim();
    if (!uri) continue;
    if (!out.mailto && /^mailto:/i.test(uri)) out.mailto = uri;
    else if (!out.https && /^https:\/\//i.test(uri)) out.https = uri;
  }
  return out;
}

// True when `deliveredTo` is this mailbox's address (base local part + domain),
// optionally carrying a "+tag". Mirrors the plus-addressing match in receive.ts
// so we only ever send from an address we actually own.
function deliveredToMatches(
  deliveredTo: string | null,
  baseLocal: string,
  domainName: string,
): boolean {
  if (!deliveredTo) return false;
  const at = deliveredTo.lastIndexOf("@");
  if (at < 1) return false;
  const local = deliveredTo.slice(0, at);
  const dom = deliveredTo.slice(at + 1);
  if (dom.toLowerCase() !== domainName.toLowerCase()) return false;
  return (local.split("+")[0] || local).toLowerCase() === baseLocal.toLowerCase();
}

export async function performUnsubscribe(
  env: Env,
  db: DB,
  msg: {
    mailboxId: string;
    deliveredTo: string | null;
    listUnsubscribe: string | null;
    listUnsubscribePost: string | null;
  },
): Promise<UnsubscribeResultDto> {
  if (!msg.listUnsubscribe) throw new HTTPException(400, { message: "no unsubscribe info" });
  const targets = parseTargets(msg.listUnsubscribe);

  if (/one-click/i.test(msg.listUnsubscribePost ?? "") && targets.https) {
    await oneClickPost(targets.https);
    return { status: "unsubscribed", method: "one-click" };
  }

  if (targets.mailto) {
    await sendMailto(env, db, msg.mailboxId, msg.deliveredTo, targets.mailto);
    return { status: "unsubscribed", method: "email" };
  }

  if (targets.https) return { status: "open", method: "link", url: targets.https };

  throw new HTTPException(422, { message: "no supported unsubscribe method" });
}

// RFC 8058: POST `List-Unsubscribe=One-Click`. Routed through the SSRF guard so
// a sender-controlled URL can't steer us at an internal address.
async function oneClickPost(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HTTPException(422, { message: "bad unsubscribe URL" });
  }
  const res = await safeRedirectFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  if ("blocked" in res)
    throw new HTTPException(400, { message: `unsubscribe blocked: ${res.reason}` });
  if (!res.ok) throw new HTTPException(502, { message: `unsubscribe failed (${res.status})` });
}

// Send the unsubscribe request as a plain email from the mailbox. The target is
// the sender's (often per-subscriber) unsubscribe address.
async function sendMailto(
  env: Env,
  db: DB,
  mailboxId: string,
  deliveredTo: string | null,
  mailto: string,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(mailto);
  } catch {
    throw new HTTPException(422, { message: "bad unsubscribe address" });
  }
  const to = decodeURIComponent(url.pathname)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) throw new HTTPException(422, { message: "no unsubscribe address" });
  const subject = url.searchParams.get("subject") || "Unsubscribe";
  const body = url.searchParams.get("body") || "Please unsubscribe me from this list.";

  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, mailboxId),
    columns: { localPart: true, domainId: true, displayName: true },
  });
  if (!mb) throw new HTTPException(404, { message: "mailbox not found" });
  const dom = await db.query.domain.findFirst({
    where: eq(domain.id, mb.domainId),
    columns: { name: true },
  });
  if (!dom) throw new HTTPException(500, { message: "domain missing" });

  // Newsletters are often subscribed under a plus/sub-address ("hi+tag@…") and
  // the sender keys the opt-out on that exact address. Send from the address the
  // mail was actually delivered to when it resolves back to this mailbox; fall
  // back to the bare base address otherwise.
  const baseAddr = `${mb.localPart}@${dom.name}`;
  const fromAddr = deliveredToMatches(deliveredTo, mb.localPart, dom.name)
    ? (deliveredTo as string)
    : baseAddr;

  try {
    await env.EMAIL.send({
      from: mb.displayName ? { name: mb.displayName, email: fromAddr } : fromAddr,
      to,
      subject,
      text: body,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HTTPException(502, { message: `unsubscribe email failed: ${detail}` });
  }
}
