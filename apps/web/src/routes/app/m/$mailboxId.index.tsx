import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MailOpen } from "lucide-react";
import { DraftList } from "@/components/draft-list.tsx";
import { ThreadList } from "@/components/thread-list.tsx";
import { EmptyState } from "@/components/ui.tsx";
import { mailboxesQuery } from "@/lib/queries.ts";
import { useDraftFeed, useThreadFeed } from "@/lib/use-feeds.ts";

export const Route = createFileRoute("/app/m/$mailboxId/")({
  component: MailboxIndex,
});

function MailboxIndex() {
  const { mailboxId } = Route.useParams();
  const { view } = Route.useSearch();
  const isDrafts = view === "drafts";
  const feed = useThreadFeed(mailboxId, view, !isDrafts);
  const drafts = useDraftFeed(mailboxId, isDrafts);
  const mailboxes = useQuery(mailboxesQuery);
  const mailbox = mailboxes.data?.mailboxes.find((m) => m.id === mailboxId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-full shrink-0 border-r md:w-[360px]">
          {isDrafts ? (
            <DraftList
              mailboxId={mailboxId}
              view={view}
              drafts={drafts.items}
              loading={drafts.loading}
              hasMore={drafts.hasMore}
              loadingMore={drafts.loadingMore}
              loadMore={drafts.loadMore}
            />
          ) : (
            <ThreadList
              mailboxId={mailboxId}
              view={view}
              threads={feed.items}
              loading={feed.loading}
              hasMore={feed.hasMore}
              loadingMore={feed.loadingMore}
              loadMore={feed.loadMore}
              expiresAt={mailbox?.expiresAt ?? null}
            />
          )}
        </aside>
        <section className="hidden flex-1 items-center justify-center bg-background text-center text-[13px] text-muted-foreground md:flex">
          <EmptyState
            icon={MailOpen}
            title="No conversation selected"
            hint="Pick a thread from the list to read or reply."
          />
        </section>
      </div>
    </div>
  );
}
