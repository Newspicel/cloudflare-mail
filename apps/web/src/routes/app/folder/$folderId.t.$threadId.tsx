import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderThreadList } from "@/components/folder-thread-list.tsx";
import { MessageView } from "@/components/message-view.tsx";
import { MessageSkeleton } from "@/components/ui.tsx";
import { foldersQuery, threadQuery } from "@/lib/queries.ts";
import { useFolderFeed } from "@/lib/use-feeds.ts";

export const Route = createFileRoute("/app/folder/$folderId/t/$threadId")({
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(threadQuery(params.threadId)),
  component: FolderThreadPage,
});

function FolderThreadPage() {
  const { folderId, threadId } = Route.useParams();
  const feed = useFolderFeed(folderId);
  const { data: threadData } = useQuery(threadQuery(threadId));
  const { data: foldersData } = useQuery(foldersQuery);
  const folder = foldersData?.folders.find((f) => f.id === folderId);

  return (
    <div className="flex h-full">
      <aside className="hidden w-[360px] shrink-0 border-r md:block">
        <FolderThreadList
          folder={folder}
          folderId={folderId}
          threads={feed.items}
          loading={feed.loading}
          hasMore={feed.hasMore}
          loadingMore={feed.loadingMore}
          loadMore={feed.loadMore}
          selectedThreadId={threadId}
        />
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden">
        {threadData ? (
          <MessageView
            thread={threadData.thread}
            messages={threadData.messages}
            folderId={folderId}
          />
        ) : (
          <MessageSkeleton />
        )}
      </section>
    </div>
  );
}
