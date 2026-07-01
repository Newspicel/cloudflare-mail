import { useQuery } from "@tanstack/react-query";
import { Folder as FolderIcon, FolderInput, Mail, MailOpen } from "lucide-react";
import { type CSSProperties, useRef } from "react";
import { api } from "@/lib/api.ts";
import {
  type FolderRow,
  type MessageLabel,
  type ThreadRow,
  threadLabelsQuery,
} from "@/lib/queries.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { useUnfileThread } from "@/lib/use-folder-mutations.ts";
import { useListVirtualizer, visibleBlock } from "@/lib/use-list-virtualizer.ts";
import {
  FolderSubmenu,
  LabelsSubmenu,
  ReminderSubmenu,
  type RowAction,
  RowContextMenu,
} from "./thread-context-menu.tsx";
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
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMore?: () => void;
}

export function FolderThreadList({
  folder,
  folderId,
  threads,
  loading,
  selectedThreadId,
  hasMore = false,
  loadingMore = false,
  loadMore,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useListVirtualizer(scrollRef, threads.length, {
    infinite: { hasMore, loadingMore, loadMore: () => loadMore?.() },
    cacheKey: `f:${folderId}`,
  });
  const vItems = virtualizer.getVirtualItems();
  const remeasure = (i: number, el: HTMLLIElement) => virtualizer.resizeItem(i, el.offsetHeight);

  const [from, to] = visibleBlock(virtualizer, threads.length);
  const visibleIds = threads.slice(from, to).map((t) => t.id);
  const { data: labelsData } = useQuery(threadLabelsQuery(visibleIds));
  const labelsByThread = labelsData?.labels;
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
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {vItems.map((vi) => {
                const t = threads[vi.index]!;
                return (
                  <FolderRowItem
                    key={t.id}
                    rowRef={virtualizer.measureElement}
                    remeasure={remeasure}
                    dataIndex={vi.index}
                    style={rowStyle(vi.start)}
                    folderId={folderId}
                    thread={t}
                    labels={labelsByThread?.[t.id]}
                    active={t.id === selectedThreadId}
                  />
                );
              })}
            </ul>
            {loadingMore && (
              <div className="py-3 text-center text-[11px] text-muted-foreground">
                Loading more…
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// Absolute placement for a virtualized row at `start` px down the spacer.
function rowStyle(start: number): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${start}px)`,
  };
}

function FolderRowItem({
  folderId,
  thread,
  labels,
  active,
  rowRef,
  remeasure,
  style,
  dataIndex,
}: {
  folderId: string;
  thread: ThreadRow;
  labels?: MessageLabel[];
  active: boolean;
  rowRef: (el: HTMLLIElement | null) => void;
  remeasure: (index: number, el: HTMLLIElement) => void;
  style: CSSProperties;
  dataIndex: number;
}) {
  const unfile = useUnfileThread();
  const unread = thread.unreadCount > 0;

  const setRead = useThreadListMutation<boolean>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: (read) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ read }) }),
  });

  const menuActions: RowAction[] = [
    {
      icon: unread ? MailOpen : Mail,
      label: unread ? "Mark as read" : "Mark as unread",
      onClick: () => setRead.mutate(unread),
    },
  ];

  return (
    <RowContextMenu
      leading={
        <>
          <LabelsSubmenu
            mailboxId={thread.mailboxId}
            threadId={thread.id}
            applied={new Set((labels ?? []).map((l) => l.id))}
          />
          <FolderSubmenu
            mailboxId={thread.mailboxId}
            threadId={thread.id}
            currentFolderId={folderId}
          />
          <ReminderSubmenu mailboxId={thread.mailboxId} threadId={thread.id} />
        </>
      }
      actions={menuActions}
    >
      <ThreadRowView
        thread={thread}
        link={{ kind: "folder", folderId }}
        active={active}
        labels={labels}
        rowRef={rowRef}
        remeasure={remeasure}
        style={style}
        dataIndex={dataIndex}
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
    </RowContextMenu>
  );
}
