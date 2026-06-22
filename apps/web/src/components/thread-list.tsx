import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Check, Inbox, Timer, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import type { MailView, ThreadRow } from "@/lib/queries.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { EmptyState, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  mailboxId: string;
  view: MailView;
  threads: ThreadRow[];
  loading?: boolean;
  selectedThreadId?: string;
  expiresAt?: string | null;
}

const VIEW_META: Record<MailView, { label: string; icon: typeof Inbox; empty: string }> = {
  inbox: { label: "Inbox", icon: Inbox, empty: "No conversations yet." },
  archive: { label: "Archive", icon: Archive, empty: "Nothing archived." },
  trash: { label: "Trash", icon: Trash2, empty: "Trash is empty." },
};

export function ThreadList({
  mailboxId,
  view,
  threads,
  loading,
  selectedThreadId,
  expiresAt,
}: Props) {
  const meta = VIEW_META[view];
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  const bulk = useMutation({
    mutationFn: async (patch: { archived?: boolean; trashed?: boolean }) => {
      const ids = [...selected];
      await Promise.all(
        ids.map((id) =>
          api(`/api/threads/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
      setSelected(new Set());
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
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
    <div className="flex h-full flex-col bg-card">
      {selecting ? (
        <div className="flex shrink-0 items-center gap-1 border-b bg-accent/40 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>
          <span className="text-[12px] font-medium">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-0.5">
            {view !== "archive" && (
              <BulkButton
                icon={Archive}
                label="Archive"
                disabled={bulk.isPending}
                onClick={() => bulk.mutate({ archived: true })}
              />
            )}
            {view === "trash" ? (
              <BulkButton
                icon={Inbox}
                label="Restore"
                disabled={bulk.isPending}
                onClick={() => bulk.mutate({ trashed: false })}
              />
            ) : (
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
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
          {(Object.keys(VIEW_META) as MailView[]).map((v) => {
            const m = VIEW_META[v];
            const active = v === view;
            return (
              <Link
                key={v}
                to="/app/m/$mailboxId"
                params={{ mailboxId }}
                search={{ view: v }}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <m.icon className="h-3.5 w-3.5" /> {m.label}
              </Link>
            );
          })}
          <span className="ml-auto pr-1 text-[11px] tabular-nums text-muted-foreground">
            {threads.length}
          </span>
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
  );
}

function BulkButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
      aria-label={label}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
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
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;
  return (
    <li className={cn("group relative flex items-stretch border-b", selected && "bg-accent/30")}>
      {active && <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />}
      <button
        type="button"
        onClick={onToggleSelect}
        aria-label={selected ? "Deselect" : "Select"}
        aria-pressed={selected}
        className={cn(
          "grid w-9 shrink-0 place-items-center text-muted-foreground transition",
          selecting ? "opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100",
        )}
      >
        <span
          className={cn(
            "grid h-4 w-4 place-items-center rounded border",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
          )}
        >
          {selected && <Check className="h-3 w-3" />}
        </span>
      </button>
      <Link
        to="/app/m/$mailboxId/t/$threadId"
        params={{ mailboxId, threadId: thread.id }}
        search={{ view }}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pr-4 text-[13px] transition",
          active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate", unread && "font-semibold")}>{label}</span>
          <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
            {formatTime(thread.lastMsgAt)}
          </span>
        </div>
        <div
          className={cn(
            "truncate text-[12px]",
            unread ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {thread.subjectNorm || "(no subject)"}
        </div>
        <div className="flex items-center gap-2">
          {thread.msgCount > 1 && (
            <span className="rounded border bg-muted px-1 text-[10px] font-medium text-muted-foreground">
              {thread.msgCount}
            </span>
          )}
          {unread && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-primary"
              role="img"
              aria-label={`${thread.unreadCount} unread`}
            />
          )}
        </div>
      </Link>
    </li>
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
        expired
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
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
