import { type RefObject, useEffect, useRef, useState } from "react";
import { haptic } from "./haptics.ts";

// Travel (px) past which a release triggers a refresh; the pull is rubber-banded
// to MAX so it always feels resistive.
const THRESHOLD = 64;
const MAX = 96;
const DAMPEN = 0.5;

export interface PullState {
  /** Current pull distance in px (0 when idle). */
  distance: number;
  /** True while the async refresh is in flight. */
  refreshing: boolean;
  /** True once the pull is far enough that releasing will refresh. */
  armed: boolean;
}

// Native (non-passive) touch pull-to-refresh for a scroll container. Engages
// only from a true top-of-list downward drag, so it never steals normal scroll.
export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>,
  // The scroll container only mounts once the list has rows; flip this true then
  // so the effect re-runs and binds to the now-present element.
  enabled = true,
): PullState {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    let startY = 0;
    let active = false;
    let pull = 0;
    let armed = false;

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || el.scrollTop > 0 || e.touches.length !== 1) {
        active = false;
        return;
      }
      startY = e.touches[0]!.clientY;
      active = true;
      pull = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const dy = e.touches[0]!.clientY - startY;
      // A scroll started, or the finger went up — hand the gesture back.
      if (dy <= 0 || el.scrollTop > 0) {
        active = false;
        setDistance(0);
        return;
      }
      e.preventDefault();
      pull = Math.min(MAX, dy * DAMPEN);
      const nowArmed = pull >= THRESHOLD;
      if (nowArmed !== armed) {
        armed = nowArmed;
        if (armed) haptic(10);
      }
      setDistance(pull);
    };

    const onEnd = () => {
      if (!active) return;
      active = false;
      if (pull >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setDistance(THRESHOLD);
        Promise.resolve(onRefresh()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setDistance(0);
        });
      } else {
        setDistance(0);
      }
      pull = 0;
      armed = false;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scrollRef, onRefresh, enabled]);

  return { distance, refreshing, armed: distance >= THRESHOLD };
}
