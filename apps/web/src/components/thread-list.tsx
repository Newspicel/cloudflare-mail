import { Link } from "@tanstack/react-router";
import { Timer } from "lucide-react";
import { cn } from "@/lib/cn.ts";
import type { ThreadRow } from "@/lib/queries.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";

interface Props {
  mailboxId: string;
  threads: ThreadRow[];
  selectedThreadId?: string;
  expiresAt?: string | null;
}

export function ThreadList({ mailboxId, threads, selectedThreadId, expiresAt }: Props) {
  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Inbox</h2>
          <span className="text-[11px] text-muted-foreground">{threads.length}</span>
        </div>
      </div>
      {expiresAt && <ExpiryBanner expiresAt={expiresAt} />}
      <ul className="flex-1 overflow-y-auto">
        {threads.map((t) => (
          <ThreadRowItem
            key={t.id}
            mailboxId={mailboxId}
            thread={t}
            active={t.id === selectedThreadId}
          />
        ))}
        {threads.length === 0 && (
          <li className="p-8 text-center text-[12px] text-muted-foreground">
            No conversations yet.
          </li>
        )}
      </ul>
    </div>
  );
}

function ThreadRowItem({
  mailboxId,
  thread,
  active,
}: {
  mailboxId: string;
  thread: ThreadRow;
  active: boolean;
}) {
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;
  return (
    <li>
      <Link
        to="/app/m/$mailboxId/t/$threadId"
        params={{ mailboxId, threadId: thread.id }}
        className={cn(
          "relative flex flex-col gap-0.5 border-b px-4 py-2.5 text-[13px] transition",
          active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
        )}
      >
        {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
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
          {unread && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
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
