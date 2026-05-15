import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import { Archive, ArrowLeft, Reply, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import type { MessageRow, ThreadRow } from "@/lib/queries.ts";
import { openCompose } from "./compose-dock.tsx";
import { LabelChips, LabelsMenu } from "./labels-menu.tsx";

interface Props {
  thread: ThreadRow;
  messages: MessageRow[];
  readOnly?: boolean;
}

export function MessageView({ thread, messages, readOnly = false }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const setState = useMutation({
    mutationFn: (patch: { archived?: boolean; trashed?: boolean }) =>
      api(`/api/threads/${thread.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["threads", thread.mailboxId] });
      qc.invalidateQueries({ queryKey: ["thread", thread.id] });
      nav({ to: "/app/m/$mailboxId", params: { mailboxId: thread.mailboxId } });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-6 py-4">
        <button
          type="button"
          className="rounded-full p-2 text-muted-foreground hover:bg-muted"
          onClick={() => history.back()}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="flex-1 truncate text-lg font-semibold tracking-tight">
          {messages[0]?.subject || thread.subjectNorm || "(no subject)"}
        </h2>
        {!readOnly && messages.at(-1) && (
          <LabelsMenu mailboxId={thread.mailboxId} messageId={messages.at(-1)!.id} />
        )}
        {!readOnly && (
          <>
            <button
              type="button"
              className="rounded-full p-2 text-muted-foreground hover:bg-muted"
              onClick={() => setState.mutate({ archived: true })}
              disabled={setState.isPending}
              aria-label="Archive (e)"
              title="Archive (e)"
            >
              <Archive className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-full p-2 text-muted-foreground hover:bg-muted"
              onClick={() => setState.mutate({ trashed: true })}
              disabled={setState.isPending}
              aria-label="Trash (#)"
              title="Trash (#)"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto bg-muted/10 p-6">
        {messages.map((m) => (
          <MessageCard key={m.id} msg={m} />
        ))}
      </div>

      {!readOnly && (
        <div className="border-t bg-card p-4">
          <button
            type="button"
            onClick={() => openCompose({ replyToMessage: messages.at(-1) ?? null })}
            className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
          >
            <Reply className="h-4 w-4" /> Reply
          </button>
        </div>
      )}
    </div>
  );
}

function MessageCard({ msg }: { msg: MessageRow }) {
  const bodyHtml = useMemo(() => {
    const html = (msg as { html?: string | null }).html ?? null;
    if (html) return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return null;
  }, [msg]);

  return (
    <article className="rounded-xl border bg-card shadow-sm">
      <header className="flex items-start justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {msg.fromName ?? msg.fromAddr}{" "}
            <span className="font-normal text-muted-foreground">&lt;{msg.fromAddr}&gt;</span>
          </div>
          <div className="text-xs text-muted-foreground">
            to {msg.toAddrs.map((a) => a.address).join(", ")}
          </div>
          <LabelChips messageId={msg.id} className="mt-1" />
        </div>
        <time className="shrink-0 text-xs text-muted-foreground">
          {new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt).toLocaleString()}
        </time>
      </header>
      <div className="prose prose-sm max-w-none px-5 py-4 dark:prose-invert">
        {bodyHtml ? (
          <div
            className="[&_*]:max-w-full"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-sm">{msg.snippet}</pre>
        )}
      </div>
    </article>
  );
}
