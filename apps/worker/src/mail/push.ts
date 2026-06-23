import type { DB } from "@cfmail/db";
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

export interface MailNotification {
  mailboxId: string;
  userIds: string[];
  title: string;
  body: string;
  url: string;
}

// Best-effort push fan-out. Sends to every device of every user who opted into
// notifications for this mailbox; prunes subscriptions the push service has
// retired (404/410). Never throws — a push failure must not fail mail delivery.
export async function notifyMailbox(db: DB, n: MailNotification): Promise<void> {
  try {
    if (n.userIds.length === 0) return;

    const opted = await db
      .select({ userId: mailboxNotify.userId })
      .from(mailboxNotify)
      .where(
        and(eq(mailboxNotify.mailboxId, n.mailboxId), inArray(mailboxNotify.userId, n.userIds)),
      );
    if (opted.length === 0) return;

    const subs = await db
      .select({
        id: pushSubscription.id,
        endpoint: pushSubscription.endpoint,
        p256dh: pushSubscription.p256dh,
        auth: pushSubscription.auth,
      })
      .from(pushSubscription)
      .where(
        inArray(
          pushSubscription.userId,
          opted.map((o) => o.userId),
        ),
      );
    if (subs.length === 0) return;

    const { privateJWK } = await getOrCreateVapid(db);
    const payload = { title: n.title, body: n.body, url: n.url };
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
    console.error("notifyMailbox failed", err);
  }
}

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
