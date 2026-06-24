// Best-effort tactile feedback for touch gestures. The Vibration API is absent
// on desktop and iOS Safari, so every call is guarded and silently no-ops.
export function haptic(pattern: number | number[] = 10): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}
