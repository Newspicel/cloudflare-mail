import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Folder as FolderIcon, FolderInput, Mail, MailOpen } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { setThreadDrag } from "@/lib/dnd.ts";
import { invalidateThreadChange } from "@/lib/invalidate.ts";
import type { FolderRow, ThreadRow } from "@/lib/queries.ts";
import { useUnfileThread } from "@/lib/use-folder-mutations.ts";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";
import { EmptyState, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  folder?: FolderRow;
  folderId: string;
  threads: ThreadRow[];
  loading?: boolean;
  selectedThreadId?: string;
}

export function FolderThreadList({ folder, folderId, threads, loading, selectedThreadId }: Props) {
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
  active,
}: {
  folderId: string;
  thread: ThreadRow;
  active: boolean;
}) {
  const qc = useQueryClient();
  const unfile = useUnfileThread();
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;

  const setRead = useMutation({
    mutationFn: (read: boolean) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ read }) }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
    onSettled: () => invalidateThreadChange(qc, thread.mailboxId, thread.id),
  });

  return (
    <li
      draggable
      onDragStart={(e) =>
        setThreadDrag(e, {
          threadId: thread.id,
          mailboxId: thread.mailboxId,
          fromFolderId: folderId,
        })
      }
      className={cn(
        "group relative flex items-stretch border-b",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />}
      <Link
        to="/app/folder/$folderId/t/$threadId"
        params={{ folderId, threadId: thread.id }}
        draggable={false}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pr-4 pl-3 text-[13px]"
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate", unread && "font-semibold")}>{label}</span>
          <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
            {formatTime(thread.lastMsgAt)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[12px]",
              unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {thread.subjectNorm || "(no subject)"}
          </span>
          {unread && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              role="img"
              aria-label={`${thread.unreadCount} unread`}
            />
          )}
          {thread.msgCount > 1 && (
            <span className="ml-auto shrink-0 rounded border bg-muted px-1 font-medium text-[10px] text-muted-foreground">
              {thread.msgCount}
            </span>
          )}
        </div>
      </Link>
      <div className="absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-muted-foreground shadow-sm">
          <RowAction
            icon={unread ? MailOpen : Mail}
            label={unread ? "Mark as read" : "Mark as unread"}
            disabled={setRead.isPending}
            onClick={() => setRead.mutate(unread)}
          />
          <RowAction
            icon={FolderInput}
            label="Remove from folder"
            disabled={unfile.isPending}
            onClick={() =>
              unfile.mutate({ folderId, threadId: thread.id, mailboxId: thread.mailboxId })
            }
          />
        </div>
      </div>
    </li>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Mail;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 hover:text-foreground"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
