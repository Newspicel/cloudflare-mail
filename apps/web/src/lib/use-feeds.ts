import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  type DraftRow,
  draftsQuery,
  folderThreadsQuery,
  type MailView,
  type ThreadRow,
  threadsQuery,
} from "./queries.ts";

// A flattened, paging-aware view over an infinite list query. Consumers get a
// plain `items` array plus the controls the virtualized lists need to pull the
// next page; the page/cursor plumbing stays hidden in here. One shape backs the
// thread, folder, and draft lists so they all virtualize and page identically.
export interface Feed<T> {
  items: T[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

interface InfiniteResult<P> {
  data?: { pages: P[] };
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

// Module-level so they're stable references (the memo below keys off them).
const pickThreads = (p: { threads: ThreadRow[] }): ThreadRow[] => p.threads;
const pickDrafts = (p: { drafts: DraftRow[] }): DraftRow[] => p.drafts;

function useFeed<T, P>(q: InfiniteResult<P>, pick: (page: P) => T[]): Feed<T> {
  const items = useMemo(() => q.data?.pages.flatMap(pick) ?? [], [q.data, pick]);
  return {
    items,
    loading: q.isLoading,
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => {
      if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
    },
  };
}

export function useThreadFeed(mailboxId: string, view: MailView, enabled = true): Feed<ThreadRow> {
  const q = useInfiniteQuery({
    ...threadsQuery(mailboxId, view),
    enabled: enabled && Boolean(mailboxId),
  });
  return useFeed(q, pickThreads);
}

export function useFolderFeed(folderId: string): Feed<ThreadRow> {
  return useFeed(useInfiniteQuery(folderThreadsQuery(folderId)), pickThreads);
}

export function useDraftFeed(mailboxId: string, enabled = true): Feed<DraftRow> {
  const q = useInfiniteQuery({ ...draftsQuery(mailboxId), enabled: enabled && Boolean(mailboxId) });
  return useFeed(q, pickDrafts);
}
