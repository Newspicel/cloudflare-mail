import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Timer } from "lucide-react";
import { useState } from "react";
import { MessageView } from "@/components/message-view.tsx";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import type { MessageRow, ThreadRow } from "@/lib/queries.ts";

interface PublicShare {
  mailbox: {
    id: string;
    address: string;
    displayName: string | null;
    type: "personal" | "group" | "service" | "temp";
    expiresAt: string | null;
  };
  threads: ThreadRow[];
}

interface PublicThread {
  thread: ThreadRow;
  messages: MessageRow[];
}

export const Route = createFileRoute("/t/$token")({
  component: PublicSharePage,
});

function PublicSharePage() {
  const { token } = Route.useParams();
  const [threadId, setThreadId] = useState<string | null>(null);

  const share = useQuery({
    queryKey: ["share", token],
    queryFn: () => api<PublicShare>(`/api/t/${token}`),
    retry: false,
  });

  const thread = useQuery({
    queryKey: ["share-thread", token, threadId],
    queryFn: () => api<PublicThread>(`/api/t/${token}/threads/${threadId}`),
    enabled: Boolean(threadId),
  });

  if (share.isPending) {
    return <CenteredMessage title="Loading…" body="" />;
  }
  if (share.isError) {
    return (
      <CenteredMessage
        title="This share link is invalid"
        body="It may have been revoked or expired."
      />
    );
  }
  const data = share.data;
  const threads = data.threads;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b bg-card px-6 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold">
          ✉
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {data.mailbox.displayName ?? data.mailbox.address}
          </div>
          <div className="truncate text-xs text-muted-foreground">{data.mailbox.address}</div>
        </div>
        {data.mailbox.expiresAt && (
          <div className="ml-auto flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            <Timer className="h-3.5 w-3.5" />
            Expires {new Date(data.mailbox.expiresAt).toLocaleString()}
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[380px] shrink-0 overflow-y-auto border-r bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold tracking-tight">Inbox</h2>
            <span className="text-xs text-muted-foreground">{threads.length}</span>
          </div>
          <ul>
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setThreadId(t.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left text-sm transition",
                    t.id === threadId ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate font-medium">
                      {t.participants[0]?.name ?? t.participants[0]?.address ?? "(unknown)"}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {formatTime(t.lastMsgAt)}
                    </span>
                  </div>
                  <div className="truncate text-[13px]">{t.subjectNorm || "(no subject)"}</div>
                </button>
              </li>
            ))}
            {threads.length === 0 && (
              <li className="p-8 text-center text-sm text-muted-foreground">
                No messages yet — share this link to receive mail here.
              </li>
            )}
          </ul>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {thread.data ? (
            <MessageView thread={thread.data.thread} messages={thread.data.messages} readOnly />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select a message to read it
            </div>
          )}
        </section>
      </div>

      <footer className="shrink-0 border-t bg-card px-6 py-2 text-center text-[11px] text-muted-foreground">
        Read-only share — replies are not available.
      </footer>
    </div>
  );
}

function CenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-background p-6 text-center">
      <div>
        <div className="mb-2 text-xl font-semibold">{title}</div>
        {body && <div className="text-sm text-muted-foreground">{body}</div>}
      </div>
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
