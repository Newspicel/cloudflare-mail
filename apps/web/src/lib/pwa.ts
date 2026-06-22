// Registers the app-shell service worker. Production only — in dev the SW would
// cache Vite's module graph and fight HMR.
export function registerSW() {
  if (import.meta.env.DEV) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
