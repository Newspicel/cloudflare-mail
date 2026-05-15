import { has, Perm } from "@cfmail/shared/permissions";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ShareLinkButton } from "@/components/share-link-button.tsx";
import { ThreadList } from "@/components/thread-list.tsx";
import { mailboxesQuery, threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId/")({
  component: MailboxIndex,
});

function MailboxIndex() {
  const { mailboxId } = Route.useParams();
  const { data } = useQuery(threadsQuery(mailboxId));
  const mailboxes = useQuery(mailboxesQuery);
  const mailbox = mailboxes.data?.mailboxes.find((m) => m.id === mailboxId);
  const canShare = mailbox ? has(mailbox.perms, Perm.MANAGE) : false;

  return (
    <div className="flex h-full flex-col">
      {canShare && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card px-4 py-1.5">
          <div className="text-[12px] font-medium text-muted-foreground">{mailbox?.address}</div>
          <ShareLinkButton mailboxId={mailboxId} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-[360px] shrink-0 border-r">
          <ThreadList
            mailboxId={mailboxId}
            threads={data?.threads ?? []}
            expiresAt={mailbox?.expiresAt ?? null}
          />
        </aside>
        <section className="flex flex-1 items-center justify-center bg-background text-center text-[13px] text-muted-foreground">
          <div className="max-w-sm">
            <div className="mb-1 text-foreground font-medium">No conversation selected</div>
            <div>Pick a thread from the list to read or reply.</div>
          </div>
        </section>
      </div>
    </div>
  );
}
