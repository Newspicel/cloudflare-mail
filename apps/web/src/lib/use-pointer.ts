import { useSyncExternalStore } from "react";

const FINE = "(pointer: fine)";

function subscribe(cb: () => void) {
  const mql = window.matchMedia(FINE);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

// True when a precise pointer (mouse/trackpad) is present. Used to gate
// right-click affordances; touch devices keep their long-press equivalents.
export function useFinePointer() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(FINE).matches,
    () => true,
  );
}
