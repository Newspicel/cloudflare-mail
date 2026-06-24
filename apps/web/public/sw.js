/// <reference lib="webworker" />
// Minimal app-shell service worker. No build step — caches static assets at
// runtime (stale-while-revalidate) and serves the cached shell when offline.
// API traffic (auth + SSE realtime) is never intercepted.

const CACHE = "cfmail-v1";
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs; let everything else (API, SSE, POST) pass through.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Clone *before* returning `res` — once it's streamed to the page the
          // body is consumed and a later clone throws.
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy));
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r || Response.error())),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          // Clone synchronously, before the body is consumed downstream.
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Set the PWA app-icon badge to the number of outstanding notifications. The
// Badging API is best-effort (unsupported on some platforms) — guard it.
async function syncAppBadge() {
  if (!self.navigator.setAppBadge) return;
  try {
    const open = await self.registration.getNotifications();
    if (open.length > 0) await self.navigator.setAppBadge(open.length);
    else await self.navigator.clearAppBadge?.();
  } catch {
    /* badging unavailable */
  }
}

// Incoming push: show a notification. Payload is JSON {title, body, url, threadId}.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "New mail";
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: data.body || "",
        icon: "/pwa-192.png",
        badge: "/pwa-192.png",
        // Tag by thread so repeat alerts coalesce and peers can target a dismiss.
        tag: data.threadId || data.url || title,
        data: { url: data.url || "/", threadId: data.threadId },
      })
      .then(syncAppBadge),
  );
});

// Page asks us to dismiss a thread's notification (it was read on this or
// another device) — close any matching notification and refresh the badge.
self.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type !== "dismiss-thread" || !msg.threadId) return;
  event.waitUntil(
    self.registration
      .getNotifications({ tag: msg.threadId })
      .then((ns) => {
        for (const n of ns) n.close();
      })
      .then(syncAppBadge),
  );
});

// Focus an existing tab (navigating it to the target) or open a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
      .then(syncAppBadge),
  );
});

self.addEventListener("notificationclose", (event) => {
  event.waitUntil(syncAppBadge());
});
