import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore, Inbox, Mail, MailOpen, ShieldAlert, Timer, Trash2, X } from "lucide-react";
import { useState } from "react";
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
import { FOLDER_META, FolderTabs } from "./folder-tabs.tsx";
import { ThreadRowView } from "./thread-row.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
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
}

export function ThreadList({
  mailboxId,
  view,
  threads,
  loading,
  selectedThreadId,
  expiresAt,
}: Props) {
  const meta = FOLDER_META[view];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  const labelsQ = useQuery(threadLabelsQuery(threads.map((t) => t.id)));
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
                <IconButton
                  icon={Inbox}
                  label="Restore"
                  size="icon-sm"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ trashed: false })}
                />
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
          <ul className="flex-1 overflow-y-auto">
            {threads.map((t) => (
              <ThreadRowItem
                key={t.id}
                mailboxId={mailboxId}
                view={view}
                thread={t}
                labels={labelsByThread?.[t.id]}
                active={t.id === selectedThreadId}
                selected={selected.has(t.id)}
                selecting={selecting}
                onToggleSelect={() => toggle(t.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </TooltipProvider>
  );
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
}: {
  mailboxId: string;
  view: MailView;
  thread: ThreadRow;
  labels?: MessageLabel[];
  active: boolean;
  selected: boolean;
  selecting: boolean;
  onToggleSelect: () => void;
}) {
  const unread = thread.unreadCount > 0;

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

  return (
    <ThreadRowView
      thread={thread}
      link={{ kind: "mailbox", mailboxId, view }}
      active={active}
      selected={selected}
      labels={labels}
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
              <IconButton
                icon={ArchiveRestore}
                label="Restore"
                size="icon-sm"
                className="h-6 w-6 hover:text-foreground"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ trashed: false })}
              />
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
