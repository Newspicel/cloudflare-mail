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
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Inbox</h2>
        <span className="text-xs text-muted-foreground">{threads.length}</span>
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
          <li className="p-8 text-center text-sm text-muted-foreground">No conversations yet.</li>
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
          "flex flex-col gap-0.5 border-b px-4 py-3 text-sm transition",
          active ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
          unread && "font-semibold",
        )}
      >
        <div className="flex items-center justify-between">
          <span className="truncate">{label}</span>
          <span className="ml-2 shrink-0 text-xs text-muted-foreground">
            {formatTime(thread.lastMsgAt)}
          </span>
        </div>
        <div className="truncate text-[13px]">{thread.subjectNorm || "(no subject)"}</div>
        <div className="flex items-center gap-2">
          {thread.msgCount > 1 && (
            <span className="rounded bg-muted px-1 text-[11px] text-muted-foreground">
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
        "flex items-center gap-2 border-b px-4 py-2 text-xs",
        expired
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      title={`Expires ${new Date(expiresAt).toLocaleString()}`}
    >
      <Timer className="h-3.5 w-3.5" />
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
