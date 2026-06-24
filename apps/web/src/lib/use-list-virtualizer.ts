import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useEffect } from "react";

interface Infinite {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

// One windowed list set-up shared by the mailbox and folder thread lists: rows
// self-measure (variable height from label chips / density), and when the tail
// of the rendered window nears the end it pulls the next page.
export function useListVirtualizer(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
  infinite?: Infinite,
): Virtualizer<HTMLElement, Element> {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

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
