import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ThreadList } from "@/components/thread-list.tsx";
import { threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId/")({
  component: MailboxIndex,
});

function MailboxIndex() {
  const { mailboxId } = Route.useParams();
  const { data } = useQuery(threadsQuery(mailboxId));

  return (
    <div className="flex h-full">
      <aside className="w-[380px] shrink-0 border-r bg-card">
        <ThreadList mailboxId={mailboxId} threads={data?.threads ?? []} />
      </aside>
      <section className="flex flex-1 items-center justify-center bg-muted/30 text-center text-sm text-muted-foreground">
        Select a conversation
      </section>
    </div>
  );
}
