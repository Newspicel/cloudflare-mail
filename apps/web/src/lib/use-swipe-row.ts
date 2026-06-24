import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";
import { haptic } from "./haptics.ts";

// Past this horizontal travel a release commits the swipe action; below it the
// row springs back. Tuned to feel like Gmail's "full swipe to act".
const COMMIT_PX = 96;
// Movement under this is treated as a tap/long-press, not a drag.
const TAP_SLOP_PX = 8;
const LONG_PRESS_MS = 500;

export interface SwipeConfig {
  /** Fires when the row is released past the commit point dragging right (→). */
  onSwipeRight?: () => void;
  /** Fires when the row is released past the commit point dragging left (←). */
  onSwipeLeft?: () => void;
  /** Fires on a stationary press-and-hold (enters multi-select / opens sheet). */
  onLongPress?: () => void;
  disabled?: boolean;
}

export interface SwipeState {
  /** Current horizontal offset of the row foreground, in px. */
  dx: number;
  /** True while the finger is down and tracking (disables the snap transition). */
  dragging: boolean;
  /** True once travel passes the commit point — used to brighten the action. */
  armed: boolean;
}

export interface SwipeHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  /** Capture-phase click suppressor: swallows the tap that follows a gesture. */
  onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

// Touch-only swipe + long-press for a list row. Mouse input is ignored so it
// never interferes with desktop hover actions or HTML5 drag-to-folder.
export function useSwipeRow(config: SwipeConfig): { state: SwipeState; handlers: SwipeHandlers } {
  const [state, setState] = useState<SwipeState>({ dx: 0, dragging: false, armed: false });
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<"none" | "x" | "y">("none");
  const armedRef = useRef(false);
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const clearLong = useCallback(() => {
    if (longTimer.current) {
      clearTimeout(longTimer.current);
      longTimer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    start.current = null;
    axis.current = "none";
    armedRef.current = false;
    clearLong();
    setState({ dx: 0, dragging: false, armed: false });
  }, [clearLong]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (config.disabled || e.pointerType !== "touch") return;
      start.current = { x: e.clientX, y: e.clientY };
      axis.current = "none";
      suppressClick.current = false;
      if (config.onLongPress) {
        longTimer.current = setTimeout(() => {
          // Long-press wins only if the finger never started a drag.
          if (axis.current === "none") {
            suppressClick.current = true;
            haptic(15);
            config.onLongPress?.();
            reset();
          }
        }, LONG_PRESS_MS);
      }
    },
    [config, reset],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!start.current) return;
      const dx = e.clientX - start.current.x;
      const dy = e.clientY - start.current.y;

      if (axis.current === "none") {
        if (Math.abs(dx) < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return;
        // Lock to the dominant axis on first real movement. Vertical hands the
        // gesture back to the scroller; horizontal becomes a swipe.
        axis.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        clearLong();
        if (axis.current === "y") return;
      }
      if (axis.current !== "x") return;

      // Only allow swipes for which an action is wired; clamp the rest at 0 so
      // the row can't be dragged into an empty reveal.
      const allowed = (dx > 0 && config.onSwipeRight) || (dx < 0 && config.onSwipeLeft) ? dx : 0;
      const armed = Math.abs(allowed) >= COMMIT_PX;
      // A short tick the moment the row crosses (or leaves) the commit point.
      if (armed !== armedRef.current && allowed !== 0) haptic(8);
      armedRef.current = armed;
      setState({ dx: allowed, dragging: true, armed });
    },
    [config, clearLong],
  );

  const finish = useCallback(() => {
    if (axis.current === "x" && Math.abs(state.dx) >= COMMIT_PX) {
      suppressClick.current = true;
      haptic(12);
      if (state.dx > 0) config.onSwipeRight?.();
      else config.onSwipeLeft?.();
    }
    reset();
  }, [state.dx, config, reset]);

  const onClickCapture = useCallback(
    (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (suppressClick.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick.current = false;
      }
    },
    [],
  );

  return {
    state,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onClickCapture,
    },
  };
}
