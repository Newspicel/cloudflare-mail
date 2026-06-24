import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore, Inbox, Mail, MailOpen, ShieldAlert, Timer, Trash2, X } from "lucide-react";
import { type CSSProperties, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { patchThreadsInLists, removeThreadsFromLists } from "@/lib/invalidate.ts";
import {
  type MailView,
  type MessageLabel,
  type ThreadRow,
  threadLabelsQuery,
} from "@/lib/queries.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { useListVirtualizer, visibleBlock } from "@/lib/use-list-virtualizer.ts";
import { FOLDER_META, FolderTabs } from "./folder-tabs.tsx";
import { ThreadRowView } from "./thread-row.tsx";
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useListVirtualizer(scrollRef, threads.length, {
    infinite: { hasMore, loadingMore, loadMore: () => loadMore?.() },
    cacheKey: `m:${mailboxId}:${view}`,
  });
  const vItems = virtualizer.getVirtualItems();

  // Labels only for the on-screen block — bounds the request and keeps its key
  // stable while scrolling within the block.
  const [from, to] = visibleBlock(virtualizer, threads.length);
  const visibleIds = useMemo(() => threads.slice(from, to).map((t) => t.id), [threads, from, to]);
  const labelsQ = useQuery(threadLabelsQuery(visibleIds));
  const labelsByThread = labelsQ.data?.labels;

  const bulk = useThreadListMutation<{ trashed?: boolean; spam?: boolean }>({
    mailboxId,
    mutationFn: (patch) =>
      Promise.all(
        [...selected].map((id) =>
          api(`/api/threads/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
        ),
      ),
    optimistic: (_patch, qc) => removeThreadsFromLists(qc, mailboxId, [...selected]),
    onApply: () => setSelected(new Set()),
  });

  const bulkDel = useThreadListMutation<string[]>({
    mailboxId,
    mutationFn: (ids) =>
      Promise.all(ids.map((id) => api(`/api/threads/${id}`, { method: "DELETE" }))),
    optimistic: (ids, qc) => removeThreadsFromLists(qc, mailboxId, ids),
    onApply: () => setSelected(new Set()),
  });

  async function deleteSelected() {
    // Only whole-thread-trashed threads can be bulk-purged. Threads surfaced in
    // Trash solely for an individually-deleted message are skipped — deleting the
    // whole thread would take its live messages with it; purge those from inside.
    const wholeTrashed = new Set(threads.filter((t) => t.trashed).map((t) => t.id));
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
              ) : view === "spam" ? (
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
              {view !== "trash" && (
                <IconButton
                  icon={Trash2}
                  label="Trash"
                  size="icon-sm"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ trashed: true })}
                />
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
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {vItems.map((vi) => {
                const t = threads[vi.index]!;
                return (
                  <ThreadRowItem
                    key={t.id}
                    rowRef={virtualizer.measureElement}
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
  rowRef,
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
  rowRef: (el: HTMLLIElement | null) => void;
  style: CSSProperties;
  dataIndex: number;
}) {
  const unread = thread.unreadCount > 0;
  const { confirmDelete } = useConfirmHelpers();

  const patch = useThreadListMutation<{ trashed?: boolean; read?: boolean }>({
    mailboxId,
    threadId: thread.id,
    mutationFn: (body) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    optimistic: (body, qc) => {
      if (body.trashed !== undefined) removeThreadsFromLists(qc, mailboxId, [thread.id]);
      else if (body.read !== undefined)
        patchThreadsInLists(qc, mailboxId, [thread.id], { unreadCount: body.read ? 0 : 1 });
    },
  });

  const del = useThreadListMutation<void>({
    mailboxId,
    threadId: thread.id,
    mutationFn: () => api(`/api/threads/${thread.id}`, { method: "DELETE" }),
    optimistic: (_v, qc) => removeThreadsFromLists(qc, mailboxId, [thread.id]),
  });

  async function remove() {
    if (await confirmDelete("this conversation")) del.mutate();
  }

  return (
    <ThreadRowView
      thread={thread}
      link={{ kind: "mailbox", mailboxId, view }}
      active={active}
      selected={selected}
      labels={labels}
      rowRef={rowRef}
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
