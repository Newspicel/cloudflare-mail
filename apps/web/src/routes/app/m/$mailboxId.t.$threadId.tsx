import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MessageView } from "@/components/message-view.tsx";
import { ThreadList } from "@/components/thread-list.tsx";
import { MessageSkeleton } from "@/components/ui.tsx";
import { mailboxesQuery, threadQuery } from "@/lib/queries.ts";
import { useThreadFeed } from "@/lib/use-feeds.ts";

export const Route = createFileRoute("/app/m/$mailboxId/t/$threadId")({
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(threadQuery(params.threadId)),
  component: ThreadPage,
});

function ThreadPage() {
  const { mailboxId, threadId } = Route.useParams();
  const { view } = Route.useSearch();
  const feed = useThreadFeed(mailboxId, view);
  const thread = useQuery(threadQuery(threadId));
  const mailboxes = useQuery(mailboxesQuery);
  const mailbox = mailboxes.data?.mailboxes.find((m) => m.id === mailboxId);

  return (
    <div className="flex h-full">
      <aside className="hidden w-[360px] shrink-0 border-r md:block">
        <ThreadList
          mailboxId={mailboxId}
          view={view}
          threads={feed.items}
          loading={feed.loading}
          hasMore={feed.hasMore}
          loadingMore={feed.loadingMore}
          loadMore={feed.loadMore}
          selectedThreadId={threadId}
          expiresAt={mailbox?.expiresAt ?? null}
        />
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden">
        {thread.data ? (
          <MessageView thread={thread.data.thread} messages={thread.data.messages} view={view} />
        ) : (
          <MessageSkeleton />
        )}
      </section>
    </div>
  );
}
