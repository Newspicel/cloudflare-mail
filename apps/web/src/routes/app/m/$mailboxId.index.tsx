import { has, Perm } from "@cfmail/shared/permissions";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MailOpen } from "lucide-react";
import { DraftList } from "@/components/draft-list.tsx";
import { ShareLinkButton } from "@/components/share-link-button.tsx";
import { ThreadList } from "@/components/thread-list.tsx";
import { EmptyState } from "@/components/ui.tsx";
import { draftsQuery, mailboxesQuery, threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId/")({
  component: MailboxIndex,
});

function MailboxIndex() {
  const { mailboxId } = Route.useParams();
  const { view } = Route.useSearch();
  const isDrafts = view === "drafts";
  const threads = useQuery({ ...threadsQuery(mailboxId, view), enabled: !isDrafts });
  const draftsQ = useQuery({ ...draftsQuery(mailboxId), enabled: isDrafts });
  const mailboxes = useQuery(mailboxesQuery);
  const mailbox = mailboxes.data?.mailboxes.find((m) => m.id === mailboxId);
  const canShare = mailbox ? has(mailbox.perms, Perm.MANAGE) : false;

  return (
    <div className="flex h-full flex-col">
      {canShare && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card px-4 py-1.5">
          <div className="truncate text-[12px] font-medium text-muted-foreground">
            {mailbox?.address}
          </div>
          <ShareLinkButton mailboxId={mailboxId} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-full shrink-0 border-r md:w-[360px]">
          {isDrafts ? (
            <DraftList
              mailboxId={mailboxId}
              view={view}
              drafts={draftsQ.data?.drafts ?? []}
              loading={draftsQ.isLoading}
            />
          ) : (
            <ThreadList
              mailboxId={mailboxId}
              view={view}
              threads={threads.data?.threads ?? []}
              loading={threads.isLoading}
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
