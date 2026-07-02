import { rpc, unwrap } from "./api.ts";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Ask the service worker to close this thread's notification (read elsewhere).
// Best-effort: no-op when the SW isn't controlling the page yet.
export function dismissThreadNotification(threadId: string): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: "dismiss-thread", threadId }))
    .catch(() => {});
}

// True when this device already has an active push subscription.
export async function isPushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  return Boolean(await reg.pushManager.getSubscription());
}

// Prompt for permission, subscribe via the VAPID key, and register the
// subscription server-side. Throws with a user-facing message on failure.
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("Notifications aren't supported in this browser.");
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    throw new Error("Service worker isn't registered yet — reload the page and try again.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was denied.");

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await unwrap(rpc.push.key.$get());
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }
  const json = sub.toJSON();
  await unwrap(
    rpc.push.subscribe.$post({
      json: {
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
      },
    }),
  );
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await unwrap(rpc.push.unsubscribe.$post({ json: { endpoint } }));
}
