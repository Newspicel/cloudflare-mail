import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useEffect, useLayoutEffect } from "react";

interface Infinite {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

interface Options {
  infinite?: Infinite;
  // Persist row measurements + scroll position under this key. Opening a thread
  // swaps the list-only route for the detail route, and since each renders its
  // own list instance React unmounts one and mounts the other. A fresh
  // virtualizer has no measurements, so every row falls back to estimateSize and
  // the list visibly jumps as ResizeObserver re-measures it. Seeding the new
  // instance from the last snapshot keeps heights (and scroll) stable.
  cacheKey?: string;
}

interface Snapshot {
  measurements: VirtualItem[];
  offset: number;
}

const snapshots = new Map<string, Snapshot>();

// One windowed list set-up shared by the mailbox and folder thread lists: rows
// self-measure (variable height from label chips / density), and when the tail
// of the rendered window nears the end it pulls the next page.
export function useListVirtualizer(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
  { infinite, cacheKey }: Options = {},
): Virtualizer<HTMLElement, Element> {
  const snap = cacheKey ? snapshots.get(cacheKey) : undefined;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
    initialMeasurementsCache: snap?.measurements,
    initialOffset: snap?.offset,
    onChange: cacheKey
      ? (v) =>
          snapshots.set(cacheKey, {
            measurements: v.measurementsCache,
            offset: v.scrollOffset ?? 0,
          })
      : undefined,
  });

  // initialOffset only feeds the windowing math; the scroll element itself
  // mounts at 0, so restore its real scrollTop once seeded measurements have
  // given the spacer its correct height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore once on mount
  useLayoutEffect(() => {
    if (snap && scrollRef.current) scrollRef.current.scrollTop = snap.offset;
  }, []);

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1]!.index : -1;

  useEffect(() => {
    if (infinite?.hasMore && !infinite.loadingMore && lastIndex >= count - 8) {
      infinite.loadMore();
    }
  }, [infinite, lastIndex, count]);

  return virtualizer;
}

// Index range of the currently-rendered window, snapped out to `block`-sized
// boundaries. Used to fetch row labels for only what's on screen (bounding the
// request size) while keeping the query key stable as you scroll within a block.
export function visibleBlock(
  virtualizer: Virtualizer<HTMLElement, Element>,
  total: number,
  block = 25,
): [number, number] {
  const items = virtualizer.getVirtualItems();
  if (items.length === 0) return [0, 0];
  const first = items[0]!.index;
  const last = items[items.length - 1]!.index;
  return [
    Math.floor(first / block) * block,
    Math.min(total, (Math.floor(last / block) + 1) * block),
  ];
}
