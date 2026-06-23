import { Link } from "@tanstack/react-router";
import { Mails } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/cn.ts";
import { clearThreadDragGhost, setThreadDrag } from "@/lib/dnd.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import type { MailView, MessageLabel, ThreadRow } from "@/lib/queries.ts";
import { formatTime } from "@/lib/time.ts";

// Where the row links to. The shape also decides the drag payload (folder rows
// carry their origin) so both list flavors share one row body.
type RowLink =
  | { kind: "mailbox"; mailboxId: string; view: MailView }
  | { kind: "folder"; folderId: string };

interface Props {
  thread: ThreadRow;
  link: RowLink;
  active: boolean;
  /** Multi-select highlight (mailbox lists only). */
  selected?: boolean;
  /** Distinct labels across the thread's messages, shown as chips. */
  labels?: MessageLabel[];
  /** Leading column, e.g. the select checkbox. */
  leading?: React.ReactNode;
  /** Hover action cluster; omit to hide it (e.g. while selecting). */
  actions?: React.ReactNode;
}

export function ThreadRowView({
  thread,
  link,
  active,
  selected = false,
  labels,
  leading,
  actions,
}: Props) {
  const { prefs } = useUserPrefs();
  const compact = prefs.density === "compact";
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;

  const onDragStart = (e: React.DragEvent) =>
    setThreadDrag(e, {
      threadId: thread.id,
      mailboxId: thread.mailboxId,
      fromFolderId: link.kind === "folder" ? link.folderId : undefined,
    });

  // Without a leading column the body provides its own left padding.
  const linkClassName = cn(
    "flex min-w-0 flex-1 flex-col gap-0.5 pr-4 text-[13px]",
    compact ? "py-1.5" : "py-2.5",
    !leading && "pl-3",
  );

  const body = (
    <>
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
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1 font-medium text-[10px] text-muted-foreground"
            title={`${thread.msgCount} messages in this thread`}
          >
            <Mails className="h-2.5 w-2.5" />
            {thread.msgCount}
          </span>
        )}
      </div>
      {labels && labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-medium text-[10px]"
              style={{ borderColor: l.color, color: l.color }}
            >
              <span className="h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          ))}
        </div>
      )}
    </>
  );

  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragEnd={clearThreadDragGhost}
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
      {leading}
      {link.kind === "mailbox" ? (
        <Link
          to="/app/m/$mailboxId/t/$threadId"
          params={{ mailboxId: link.mailboxId, threadId: thread.id }}
          search={{ view: link.view }}
          draggable={false}
          className={linkClassName}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/app/folder/$folderId/t/$threadId"
          params={{ folderId: link.folderId, threadId: thread.id }}
          draggable={false}
          className={linkClassName}
        >
          {body}
        </Link>
      )}
      {actions && (
        <div className="absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-muted-foreground shadow-sm">
            {actions}
          </div>
        </div>
      )}
    </li>
  );
}
