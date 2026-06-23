import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArchiveRestore, Inbox, Mail, MailOpen, ShieldAlert, Timer, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { setThreadDrag } from "@/lib/dnd.ts";
import {
  invalidateThreadChange,
  patchThreadsInLists,
  removeThreadsFromLists,
  restoreSnapshot,
  snapshotMailboxThreads,
} from "@/lib/invalidate.ts";
import type { MailView, ThreadRow } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { FOLDER_META, FolderTabs } from "./folder-tabs.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";
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
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  const bulk = useMutation({
    mutationFn: async (patch: { trashed?: boolean; spam?: boolean }) => {
      const ids = [...selected];
      await Promise.all(
        ids.map((id) =>
          api(`/api/threads/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
        ),
      );
    },
    onMutate: async () => {
      const ids = [...selected];
      await qc.cancelQueries({ queryKey: keys.threadsRoot(mailboxId) });
      const snapshot = snapshotMailboxThreads(qc, mailboxId);
      removeThreadsFromLists(qc, mailboxId, ids);
      setSelected(new Set());
      return { snapshot };
    },
    onError: (e: unknown, _patch, ctx) => {
      if (ctx) restoreSnapshot(qc, ctx.snapshot);
      toast.error(e instanceof Error ? e.message : "Failed");
    },
    onSettled: () => invalidateThreadChange(qc, mailboxId),
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
            <Tooltip label="Clear selection">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSelected(new Set())}
                aria-label="Clear selection"
              >
                <X />
              </Button>
            </Tooltip>
            <span className="font-medium text-[12px]">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-0.5">
              {view === "trash" ? (
                <BulkButton
                  icon={Inbox}
                  label="Restore"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ trashed: false })}
                />
              ) : view === "spam" ? (
                <BulkButton
                  icon={Inbox}
                  label="Not spam"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ spam: false })}
                />
              ) : (
                <BulkButton
                  icon={ShieldAlert}
                  label="Mark as spam"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ spam: true })}
                />
              )}
              {view !== "trash" && (
                <BulkButton
                  icon={Trash2}
                  label="Trash"
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

function BulkButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Trash2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

function ThreadRowItem({
  mailboxId,
  view,
  thread,
  active,
  selected,
  selecting,
  onToggleSelect,
}: {
  mailboxId: string;
  view: MailView;
  thread: ThreadRow;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  onToggleSelect: () => void;
}) {
  const qc = useQueryClient();
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;

  const patch = useMutation({
    mutationFn: (body: { trashed?: boolean; read?: boolean }) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: keys.threadsRoot(mailboxId) });
      const snapshot = snapshotMailboxThreads(qc, mailboxId);
      if (body.trashed !== undefined) {
        removeThreadsFromLists(qc, mailboxId, [thread.id]);
      } else if (body.read !== undefined) {
        patchThreadsInLists(qc, mailboxId, [thread.id], { unreadCount: body.read ? 0 : 1 });
      }
      return { snapshot };
    },
    onError: (e: unknown, _body, ctx) => {
      if (ctx) restoreSnapshot(qc, ctx.snapshot);
      toast.error(e instanceof Error ? e.message : "Failed");
    },
    onSettled: () => invalidateThreadChange(qc, mailboxId, thread.id),
  });

  return (
    <li
      draggable
      onDragStart={(e) => setThreadDrag(e, { threadId: thread.id, mailboxId: thread.mailboxId })}
      className={cn(
        "group relative flex items-stretch border-b",
        active
          ? "bg-accent text-accent-foreground"
          : selected
            ? "bg-accent/40"
            : "hover:bg-muted/60",
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />}
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
      <Link
        to="/app/m/$mailboxId/t/$threadId"
        params={{ mailboxId, threadId: thread.id }}
        search={{ view }}
        draggable={false}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pr-4 text-[13px]"
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
      {!selecting && (
        <div className="absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-muted-foreground shadow-sm">
            <RowAction
              icon={unread ? MailOpen : Mail}
              label={unread ? "Mark as read" : "Mark as unread"}
              disabled={patch.isPending}
              onClick={() => patch.mutate({ read: unread })}
            />
            {view === "trash" ? (
              <RowAction
                icon={ArchiveRestore}
                label="Restore"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ trashed: false })}
              />
            ) : (
              <RowAction
                icon={Trash2}
                label="Trash"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ trashed: true })}
              />
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Trash2;
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
