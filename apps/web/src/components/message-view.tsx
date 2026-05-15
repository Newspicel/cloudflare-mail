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
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
        <ToolbarButton onClick={() => history.back()} ariaLabel="Back">
          <ArrowLeft className="h-4 w-4" />
        </ToolbarButton>
        <h2 className="flex-1 truncate text-[14px] font-semibold tracking-tight">
          {messages[0]?.subject || thread.subjectNorm || "(no subject)"}
        </h2>
        {!readOnly && messages.at(-1) && (
          <LabelsMenu mailboxId={thread.mailboxId} messageId={messages.at(-1)!.id} />
        )}
        {!readOnly && (
          <>
            <ToolbarButton
              onClick={() => setState.mutate({ archived: true })}
              disabled={setState.isPending}
              ariaLabel="Archive (e)"
            >
              <Archive className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => setState.mutate({ trashed: true })}
              disabled={setState.isPending}
              ariaLabel="Trash (#)"
            >
              <Trash2 className="h-4 w-4" />
            </ToolbarButton>
          </>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => (
          <MessageCard key={m.id} msg={m} />
        ))}
      </div>

      {!readOnly && (
        <div className="border-t bg-card p-3">
          <button
            type="button"
            onClick={() => openCompose({ replyToMessage: messages.at(-1) ?? null })}
            className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-medium text-foreground transition hover:bg-muted"
          >
            <Reply className="h-3.5 w-3.5" /> Reply
          </button>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  onClick,
  disabled,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {children}
    </button>
  );
}

function MessageCard({ msg }: { msg: MessageRow }) {
  const bodyHtml = useMemo(() => {
    const html = (msg as { html?: string | null }).html ?? null;
    if (html) return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return null;
  }, [msg]);

  return (
    <article className="rounded-md border bg-card">
      <header className="flex items-start justify-between gap-4 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">
            {msg.fromName ?? msg.fromAddr}{" "}
            <span className="font-normal text-muted-foreground">&lt;{msg.fromAddr}&gt;</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            to {msg.toAddrs.map((a) => a.address).join(", ")}
          </div>
          <LabelChips messageId={msg.id} className="mt-1.5" />
        </div>
        <time className="shrink-0 text-[11px] text-muted-foreground">
          {new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt).toLocaleString()}
        </time>
      </header>
      <div className="prose prose-sm max-w-none px-4 py-3 dark:prose-invert">
        {bodyHtml ? (
          <div
            className="[&_*]:max-w-full"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-[13px]">{msg.snippet}</pre>
        )}
      </div>
    </article>
  );
}
