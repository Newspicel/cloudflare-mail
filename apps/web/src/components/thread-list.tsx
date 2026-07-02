import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  Flag,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  ShieldAlert,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { patchThreadsInLists, removeThreadsFromLists } from "@/lib/invalidate.ts";
import {
  type MailView,
  type MessageLabel,
  type ThreadRow,
  threadLabelsQuery,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { useListVirtualizer, visibleBlock } from "@/lib/use-list-virtualizer.ts";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh.ts";
import { FOLDER_META, FolderTabs } from "./folder-tabs.tsx";
import { BulkLabelsMenu } from "./labels-menu.tsx";
import { MoveToFolderMenu } from "./move-to-folder-menu.tsx";
import { ThreadActionSheet } from "./thread-action-sheet.tsx";
import {
  FolderSubmenu,
  LabelsSubmenu,
  ReminderSubmenu,
  type RowAction,
  RowContextMenu,
} from "./thread-context-menu.tsx";
import { type RowSwipe, ThreadRowView } from "./thread-row.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { EmptyState, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  mailboxId: string;
  view: MailView;
  threads: ThreadRow[];
  loading?: boolean;
  selectedThreadId?: string;
  expiresAt?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMore?: () => void;
}

export function ThreadList({
  mailboxId,
  view,
  threads,
  loading,
  selectedThreadId,
  expiresAt,
  hasMore = false,
  loadingMore = false,
  loadMore,
}: Props) {
  const meta = FOLDER_META[view];
  const { confirmDelete } = useConfirmHelpers();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const onRefresh = () => queryClient.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
  const ready = !loading && threads.length > 0;
  const pull = usePullToRefresh(scrollRef, onRefresh, ready);
  const virtualizer = useListVirtualizer(scrollRef, threads.length, {
    infinite: { hasMore, loadingMore, loadMore: () => loadMore?.() },
    cacheKey: `m:${mailboxId}:${view}`,
  });
  const vItems = virtualizer.getVirtualItems();
  const remeasure = (i: number, el: HTMLLIElement) => virtualizer.resizeItem(i, el.offsetHeight);

  // Labels only for the on-screen block — bounds the request and keeps its key
  // stable while scrolling within the block.
  const [from, to] = visibleBlock(virtualizer, threads.length);
  const visibleIds = threads.slice(from, to).map((t) => t.id);
  const { data: labelsData } = useQuery(threadLabelsQuery(visibleIds));
  const labelsByThread: Record<string, MessageLabel[]> | undefined = labelsData?.labels;

  const bulk = useThreadListMutation<{ trashed?: boolean; spam?: boolean }>({
    mailboxId,
    mutationFn: (patch) =>
      Promise.all(
        [...selected].map((id) =>
          unwrap(rpc.threads[":id"].$patch({ param: { id }, json: patch })),
        ),
      ),
    optimistic: (_patch, qc) => removeThreadsFromLists(qc, mailboxId, [...selected]),
    onApply: () => setSelected(new Set()),
  });

  const bulkRead = useThreadListMutation<boolean>({
    mailboxId,
    mutationFn: (read) =>
      Promise.all(
        [...selected].map((id) =>
          unwrap(rpc.threads[":id"].$patch({ param: { id }, json: { read } })),
        ),
      ),
    optimistic: (read, qc) =>
      patchThreadsInLists(qc, mailboxId, [...selected], { unreadCount: read ? 0 : 1 }),
  });

  const bulkDel = useThreadListMutation<string[]>({
    mailboxId,
    mutationFn: (ids) =>
      Promise.all(ids.map((id) => unwrap(rpc.threads[":id"].$delete({ param: { id } })))),
    optimistic: (ids, qc) => removeThreadsFromLists(qc, mailboxId, ids),
    onApply: () => setSelected(new Set()),
  });

  async function deleteSelected() {
    // Only whole-thread-trashed threads can be bulk-purged. Threads surfaced in
    // Trash solely for an individually-deleted message are skipped — deleting the
    // whole thread would take its live messages with it; purge those from inside.
    const wholeTrashed = new Set(threads.flatMap((t) => (t.trashed ? [t.id] : [])));
    const ids = [...selected].filter((id) => wholeTrashed.has(id));
    if (ids.length === 0) {
      toast.message("Open the conversation to delete its message permanently.");
      return;
    }
    const subject = ids.length === 1 ? "this conversation" : `${ids.length} conversations`;
    if (!(await confirmDelete(subject))) return;
    bulkDel.mutate(ids);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-card">
        {selecting ? (
          <div className="flex h-11 shrink-0 items-center gap-1 border-b bg-accent/50 px-2">
            <IconButton
              icon={X}
              label="Clear selection"
              size="icon-sm"
              onClick={() => setSelected(new Set())}
            />
            <span className="font-medium text-[12px]">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-0.5">
              {view === "trash" ? (
                <>
                  <IconButton
                    icon={Inbox}
                    label="Restore"
                    size="icon-sm"
                    disabled={bulk.isPending}
                    onClick={() => bulk.mutate({ trashed: false })}
                  />
                  <IconButton
                    icon={Trash2}
                    label="Delete permanently"
                    size="icon-sm"
                    disabled={bulkDel.isPending}
                    onClick={deleteSelected}
                  />
                </>
              ) : (
                <>
                  <IconButton
                    icon={MailOpen}
                    label="Mark as read"
                    size="icon-sm"
                    disabled={bulkRead.isPending}
                    onClick={() => bulkRead.mutate(true)}
                  />
                  <IconButton
                    icon={Mail}
                    label="Mark as unread"
                    size="icon-sm"
                    disabled={bulkRead.isPending}
                    onClick={() => bulkRead.mutate(false)}
                  />
                  <BulkLabelsMenu mailboxId={mailboxId} threadIds={[...selected]} size="icon-sm" />
                  <MoveToFolderMenu
                    mailboxId={mailboxId}
                    threadIds={[...selected]}
                    size="icon-sm"
                    onMoved={(folderName) => {
                      toast.success(`Moved to ${folderName}`);
                      setSelected(new Set());
                    }}
                  />
                  {view === "spam" ? (
                    <IconButton
                      icon={Inbox}
                      label="Not spam"
                      size="icon-sm"
                      disabled={bulk.isPending}
                      onClick={() => bulk.mutate({ spam: false })}
                    />
                  ) : (
                    <IconButton
                      icon={ShieldAlert}
                      label="Mark as spam"
                      size="icon-sm"
                      disabled={bulk.isPending}
                      onClick={() => bulk.mutate({ spam: true })}
                    />
                  )}
                  <IconButton
                    icon={Trash2}
                    label="Trash"
                    size="icon-sm"
                    disabled={bulk.isPending}
                    onClick={() => bulk.mutate({ trashed: true })}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
            <FolderTabs mailboxId={mailboxId} view={view} />
          </div>
        )}
        {expiresAt && <ExpiryBanner expiresAt={expiresAt} />}
        {loading ? (
          <ThreadListSkeleton />
        ) : threads.length === 0 ? (
          <EmptyState icon={meta.icon} title={meta.empty} className="m-auto" />
        ) : (
          <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
            {(pull.distance > 0 || pull.refreshing) && (
              <div
                className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center"
                style={{ transform: `translateY(${Math.max(pull.distance - 28, 4)}px)` }}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm">
                  <Loader2
                    className={cn(
                      "h-4 w-4",
                      pull.refreshing ? "animate-spin" : "transition-transform",
                    )}
                    style={
                      pull.refreshing ? undefined : { transform: `rotate(${pull.distance * 3}deg)` }
                    }
                  />
                </span>
              </div>
            )}
            <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {vItems.map((vi) => {
                const t = threads[vi.index]!;
                return (
                  <ThreadRowItem
                    key={t.id}
                    rowRef={virtualizer.measureElement}
                    remeasure={remeasure}
                    dataIndex={vi.index}
                    style={rowStyle(vi.start)}
                    mailboxId={mailboxId}
                    view={view}
                    thread={t}
                    labels={labelsByThread?.[t.id]}
                    active={t.id === selectedThreadId}
                    selected={selected.has(t.id)}
                    selecting={selecting}
                    onToggleSelect={() => toggle(t.id)}
                    onRequestSelect={() => setSelected(new Set([t.id]))}
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

function ThreadRowItem({
  mailboxId,
  view,
  thread,
  labels,
  active,
  selected,
  selecting,
  onToggleSelect,
  onRequestSelect,
  rowRef,
  remeasure,
  style,
  dataIndex,
}: {
  mailboxId: string;
  view: MailView;
  thread: ThreadRow;
  labels?: MessageLabel[];
  active: boolean;
  selected: boolean;
  selecting: boolean;
  onToggleSelect: () => void;
  onRequestSelect: () => void;
  rowRef: (el: HTMLLIElement | null) => void;
  remeasure: (index: number, el: HTMLLIElement) => void;
  style: CSSProperties;
  dataIndex: number;
}) {
  const unread = thread.unreadCount > 0;
  const { confirmDelete } = useConfirmHelpers();
  const [sheetOpen, setSheetOpen] = useState(false);

  const patch = useThreadListMutation<{ trashed?: boolean; read?: boolean; spam?: boolean }>({
    mailboxId,
    threadId: thread.id,
    mutationFn: (body) =>
      unwrap(rpc.threads[":id"].$patch({ param: { id: thread.id }, json: body })),
    optimistic: (body, qc) => {
      if (body.trashed !== undefined || body.spam !== undefined)
        removeThreadsFromLists(qc, mailboxId, [thread.id]);
      else if (body.read !== undefined)
        patchThreadsInLists(qc, mailboxId, [thread.id], { unreadCount: body.read ? 0 : 1 });
    },
  });

  const del = useThreadListMutation<void>({
    mailboxId,
    threadId: thread.id,
    mutationFn: () => unwrap(rpc.threads[":id"].$delete({ param: { id: thread.id } })),
    optimistic: (_v, qc) => removeThreadsFromLists(qc, mailboxId, [thread.id]),
  });

  async function remove() {
    if (await confirmDelete("this conversation")) del.mutate();
  }

  // Swipe-to-trash is reversible, so confirm-free: offer an Undo toast instead.
  function trashWithUndo() {
    patch.mutate({ trashed: true });
    toast.success("Moved to Trash", {
      action: { label: "Undo", onClick: () => patch.mutate({ trashed: false }) },
    });
  }

  // Touch gestures (mailbox lists only). Suspended while multi-selecting so a
  // swipe can't fight the selection bar.
  const swipe: RowSwipe | undefined = selecting
    ? undefined
    : {
        onLongPress: () => setSheetOpen(true),
        right:
          view === "trash"
            ? thread.trashed
              ? {
                  icon: ArchiveRestore,
                  label: "Restore",
                  className: "bg-emerald-600",
                  onCommit: () => patch.mutate({ trashed: false }),
                }
              : undefined
            : {
                icon: unread ? MailOpen : Mail,
                label: unread ? "Mark read" : "Mark unread",
                className: "bg-sky-600",
                onCommit: () => patch.mutate({ read: unread }),
              },
        left:
          view === "trash"
            ? thread.trashed
              ? { icon: Trash2, label: "Delete", className: "bg-destructive", onCommit: remove }
              : undefined
            : {
                icon: Trash2,
                label: "Trash",
                className: "bg-destructive",
                onCommit: trashWithUndo,
              },
      };

  // Right-click actions mirror the hover cluster + long-press sheet.
  const menuActions: RowAction[] = [
    {
      icon: unread ? MailOpen : Mail,
      label: unread ? "Mark as read" : "Mark as unread",
      onClick: () => patch.mutate({ read: unread }),
    },
  ];
  if (view === "trash") {
    if (thread.trashed) {
      menuActions.push({
        icon: ArchiveRestore,
        label: "Restore",
        onClick: () => patch.mutate({ trashed: false }),
      });
      menuActions.push({
        icon: Trash2,
        label: "Delete permanently",
        variant: "destructive",
        separatorBefore: true,
        onClick: remove,
      });
    }
  } else {
    menuActions.push({
      icon: ShieldAlert,
      label: view === "spam" ? "Not spam" : "Mark as spam",
      onClick: () => patch.mutate({ spam: view !== "spam" }),
    });
    if (view !== "spam") {
      menuActions.push({
        icon: Flag,
        label: "Report",
        onClick: () => patch.mutate({ spam: true }),
      });
    }
    menuActions.push({
      icon: Trash2,
      label: "Trash",
      variant: "destructive",
      separatorBefore: true,
      onClick: trashWithUndo,
    });
  }

  return (
    <>
      <ThreadActionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        thread={thread}
        view={view}
        onToggleRead={() => patch.mutate({ read: unread })}
        onTrash={trashWithUndo}
        onRestore={() => patch.mutate({ trashed: false })}
        onDelete={remove}
        onSpam={(spam) => patch.mutate({ spam })}
        onSelect={onRequestSelect}
      />
      <RowContextMenu
        leading={
          view === "trash" ? undefined : (
            <>
              <LabelsSubmenu
                mailboxId={mailboxId}
                threadId={thread.id}
                applied={new Set((labels ?? []).map((l) => l.id))}
              />
              <FolderSubmenu mailboxId={mailboxId} threadId={thread.id} />
              <ReminderSubmenu mailboxId={mailboxId} threadId={thread.id} />
            </>
          )
        }
        actions={menuActions}
      >
        <ThreadRowView
          swipe={swipe}
          thread={thread}
          link={{ kind: "mailbox", mailboxId, view }}
          active={active}
          selected={selected}
          labels={labels}
          rowRef={rowRef}
          remeasure={remeasure}
          style={style}
          dataIndex={dataIndex}
          leading={
            <div
              className={cn(
                "flex w-9 shrink-0 items-center justify-center transition-opacity",
                selecting || selected
                  ? "opacity-100"
                  : // No hover on touch: keep the checkbox visible below md (the
                    // full-width mobile list) so multi-select is reachable.
                    "opacity-100 md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100",
              )}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={onToggleSelect}
                aria-label={selected ? "Deselect" : "Select"}
              />
            </div>
          }
          actions={
            selecting ? undefined : (
              <>
                <IconButton
                  icon={unread ? MailOpen : Mail}
                  label={unread ? "Mark as read" : "Mark as unread"}
                  size="icon-sm"
                  className="h-6 w-6 hover:text-foreground"
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ read: unread })}
                />
                {view === "trash" ? (
                  // Whole-thread restore/delete only apply when the thread itself is
                  // trashed. A thread surfaced here only for an individually-deleted
                  // message is managed inside the thread (per-message restore/delete),
                  // so the destructive whole-thread shortcuts are withheld.
                  thread.trashed ? (
                    <>
                      <IconButton
                        icon={ArchiveRestore}
                        label="Restore"
                        size="icon-sm"
                        className="h-6 w-6 hover:text-foreground"
                        disabled={patch.isPending}
                        onClick={() => patch.mutate({ trashed: false })}
                      />
                      <IconButton
                        icon={Trash2}
                        label="Delete permanently"
                        size="icon-sm"
                        className="h-6 w-6 hover:text-foreground"
                        disabled={del.isPending}
                        onClick={remove}
                      />
                    </>
                  ) : null
                ) : (
                  <IconButton
                    icon={Trash2}
                    label="Trash"
                    size="icon-sm"
                    className="h-6 w-6 hover:text-foreground"
                    disabled={patch.isPending}
                    onClick={() => patch.mutate({ trashed: true })}
                  />
                )}
              </>
            )
          }
        />
      </RowContextMenu>
    </>
  );
}

function ExpiryBanner({ expiresAt }: { expiresAt: string }) {
  useNow(60_000);
  const remaining = formatRemaining(expiresAt);
  if (!remaining) return null;
  const expired = remaining === "expired";
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-4 py-1.5 text-[11px]",
        expired ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning-foreground",
      )}
      title={`Expires ${new Date(expiresAt).toLocaleString()}`}
    >
      <Timer className="h-3 w-3" />
      <span>{expired ? "Mailbox expired" : `Temp mailbox · expires in ${remaining}`}</span>
    </div>
  );
}
