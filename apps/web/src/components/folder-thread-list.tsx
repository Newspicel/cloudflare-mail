import { useQuery } from "@tanstack/react-query";
import { Folder as FolderIcon, FolderInput, Mail, MailOpen } from "lucide-react";
import { api } from "@/lib/api.ts";
import {
  type FolderRow,
  type MessageLabel,
  type ThreadRow,
  threadLabelsQuery,
} from "@/lib/queries.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { useUnfileThread } from "@/lib/use-folder-mutations.ts";
import { ThreadRowView } from "./thread-row.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { EmptyState, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  folder?: FolderRow;
  folderId: string;
  threads: ThreadRow[];
  loading?: boolean;
  selectedThreadId?: string;
}

export function FolderThreadList({ folder, folderId, threads, loading, selectedThreadId }: Props) {
  const labelsQ = useQuery(threadLabelsQuery(threads.map((t) => t.id)));
  const labelsByThread = labelsQ.data?.labels;
  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-card">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: folder?.color ?? "#64748b" }}
          />
          <span className="truncate font-semibold text-[13px]">{folder?.name ?? "Folder"}</span>
          <span className="ml-auto pr-1 text-[11px] text-muted-foreground tabular-nums">
            {threads.length}
          </span>
        </div>
        {loading ? (
          <ThreadListSkeleton />
        ) : threads.length === 0 ? (
          <EmptyState
            icon={FolderIcon}
            title="This folder is empty"
            hint="Drag a conversation onto the folder to file it here."
            className="m-auto"
          />
        ) : (
          <ul className="flex-1 overflow-y-auto">
            {threads.map((t) => (
              <FolderRowItem
                key={t.id}
                folderId={folderId}
                thread={t}
                labels={labelsByThread?.[t.id]}
                active={t.id === selectedThreadId}
              />
            ))}
          </ul>
        )}
      </div>
    </TooltipProvider>
  );
}

function FolderRowItem({
  folderId,
  thread,
  labels,
  active,
}: {
  folderId: string;
  thread: ThreadRow;
  labels?: MessageLabel[];
  active: boolean;
}) {
  const unfile = useUnfileThread();
  const unread = thread.unreadCount > 0;

  const setRead = useThreadListMutation<boolean>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: (read) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ read }) }),
  });

  return (
    <ThreadRowView
      thread={thread}
      link={{ kind: "folder", folderId }}
      active={active}
      labels={labels}
      actions={
        <>
          <IconButton
            icon={unread ? MailOpen : Mail}
            label={unread ? "Mark as read" : "Mark as unread"}
            size="icon-sm"
            className="h-6 w-6 hover:text-foreground"
            disabled={setRead.isPending}
            onClick={() => setRead.mutate(unread)}
          />
          <IconButton
            icon={FolderInput}
            label="Remove from folder"
            size="icon-sm"
            className="h-6 w-6 hover:text-foreground"
            disabled={unfile.isPending}
            onClick={() =>
              unfile.mutate({ folderId, threadId: thread.id, mailboxId: thread.mailboxId })
            }
          />
        </>
      }
    />
  );
}
