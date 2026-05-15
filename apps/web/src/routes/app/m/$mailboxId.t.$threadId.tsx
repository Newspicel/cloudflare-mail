import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MessageView } from "@/components/message-view.tsx";
import { ThreadList } from "@/components/thread-list.tsx";
import { mailboxesQuery, threadQuery, threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId/t/$threadId")({
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(threadQuery(params.threadId)),
  component: ThreadPage,
});

function ThreadPage() {
  const { mailboxId, threadId } = Route.useParams();
  const threads = useQuery(threadsQuery(mailboxId));
  const thread = useQuery(threadQuery(threadId));
  const mailboxes = useQuery(mailboxesQuery);
  const mailbox = mailboxes.data?.mailboxes.find((m) => m.id === mailboxId);

  return (
    <div className="flex h-full">
      <aside className="w-[380px] shrink-0 border-r bg-card">
        <ThreadList
          mailboxId={mailboxId}
          threads={threads.data?.threads ?? []}
          selectedThreadId={threadId}
          expiresAt={mailbox?.expiresAt ?? null}
        />
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden">
        {thread.data && <MessageView thread={thread.data.thread} messages={thread.data.messages} />}
      </section>
    </div>
  );
}
