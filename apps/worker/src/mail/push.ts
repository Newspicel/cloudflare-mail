import type { DB } from "@cfmail/db";
import type { AiPriority } from "@cfmail/db/enums";
import { mailboxNotify, pushSubscription } from "@cfmail/db/schema";
import { buildPushHTTPRequest } from "@pushforge/builder";
import { and, eq, inArray } from "drizzle-orm";
import { getConfig, setConfig } from "../config.ts";
import { safeRedirectFetch } from "../ssrf.ts";

const VAPID_PUBLIC = "vapid_public";
const VAPID_PRIVATE = "vapid_private_jwk";
// Anonymous contact required by the VAPID spec; never receives mail.
const ADMIN_CONTACT = "mailto:push@cfmail.invalid";

export interface VapidKeys {
  publicKey: string;
  privateJWK: string;
}

// Returns the server VAPID key pair, generating + persisting one on first call.
// Mirrors getOrCreateAuthSecret's race handling: write-if-absent, then read back.
export async function getOrCreateVapid(db: DB): Promise<VapidKeys> {
  const [pub, priv] = await Promise.all([
    getConfig(db, VAPID_PUBLIC),
    getConfig(db, VAPID_PRIVATE),
  ]);
  if (pub && priv) return { publicKey: pub, privateJWK: priv };

  const keypair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keypair.privateKey)) as JsonWebKey;
  const privateJWK = JSON.stringify({ alg: "ES256", ...jwk });
  const rawPub = (await crypto.subtle.exportKey("raw", keypair.publicKey)) as ArrayBuffer;
  const publicKey = base64UrlEncode(rawPub);

  // setConfig upserts; concurrent isolates converge because both keys are
  // written together and we read them back below.
  await setConfig(db, VAPID_PUBLIC, publicKey);
  await setConfig(db, VAPID_PRIVATE, privateJWK);
  return { publicKey, privateJWK };
}

// The encrypted payload a service worker renders. `threadId` is the stable tag
// peers use to dismiss/coalesce a notification per thread. A `type` (not
// `interface`) so it satisfies the builder's Jsonifiable index signature.
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  threadId: string;
  // Resolved notification style the SW renders. "important" is sticky/vibrates.
  level?: "normal" | "important";
};

export interface MailNotification extends Omit<PushPayload, "level"> {
  mailboxId: string;
  userIds: string[];
  // AI-judged priority of the message; resolved per-user against the mailbox's
  // per-tier config to pick the notification style (or skip).
  priority: AiPriority;
}

// Best-effort push fan-out to every device of the given users; prunes
// subscriptions the push service has retired (404/410). Never throws — a push
// failure must not fail the operation that triggered it.
export async function pushToUsers(db: DB, userIds: string[], payload: PushPayload): Promise<void> {
  try {
    if (userIds.length === 0) return;

    const subs = await db
      .select({
        id: pushSubscription.id,
        endpoint: pushSubscription.endpoint,
        p256dh: pushSubscription.p256dh,
        auth: pushSubscription.auth,
      })
      .from(pushSubscription)
      .where(inArray(pushSubscription.userId, userIds));
    if (subs.length === 0) return;

    const { privateJWK } = await getOrCreateVapid(db);
    const dead: string[] = [];

    await Promise.all(
      subs.map(async (sub) => {
        try {
          const { endpoint, headers, body } = await buildPushHTTPRequest({
            privateJWK,
            subscription: {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            message: {
              payload,
              adminContact: ADMIN_CONTACT,
              options: { ttl: 12 * 60 * 60, urgency: "high" },
            },
          });
          // Endpoints are validated at registration, but re-guard each hop:
          // a push host that 302s elsewhere must not steer us at an internal
          // target (blind status-only oracle otherwise).
          const res = await safeRedirectFetch(new URL(endpoint), { method: "POST", headers, body });
          if ("blocked" in res) return;
          if (res.status === 404 || res.status === 410) dead.push(sub.id);
        } catch (err) {
          console.error("push send failed", err);
        }
      }),
    );

    if (dead.length > 0) {
      await db.delete(pushSubscription).where(inArray(pushSubscription.id, dead));
    }
  } catch (err) {
    console.error("pushToUsers failed", err);
  }
}

// Push fan-out gated on each user's per-mailbox config. The message's AI
// priority selects which configured tier (high/normal/low) applies; each user's
// tier value maps to a notification style — "none" skips them, otherwise we fan
// out with the resolved "normal"/"important" style. Never throws (invariant 8).
export async function notifyMailbox(db: DB, n: MailNotification): Promise<void> {
  try {
    if (n.userIds.length === 0) return;

    const rows = await db
      .select({
        userId: mailboxNotify.userId,
        high: mailboxNotify.high,
        normal: mailboxNotify.normal,
        low: mailboxNotify.low,
      })
      .from(mailboxNotify)
      .where(
        and(eq(mailboxNotify.mailboxId, n.mailboxId), inArray(mailboxNotify.userId, n.userIds)),
      );
    if (rows.length === 0) return;

    const byStyle: Record<"normal" | "important", string[]> = { normal: [], important: [] };
    for (const r of rows) {
      const style = r[n.priority];
      if (style === "none") continue;
      byStyle[style].push(r.userId);
    }

    const payload = { title: n.title, body: n.body, url: n.url, threadId: n.threadId };
    for (const style of ["normal", "important"] as const) {
      if (byStyle[style].length > 0) {
        await pushToUsers(db, byStyle[style], { ...payload, level: style });
      }
    }
  } catch (err) {
    console.error("notifyMailbox failed", err);
  }
}

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
