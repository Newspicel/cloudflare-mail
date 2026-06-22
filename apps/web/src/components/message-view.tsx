import { Flag, hasFlag } from "@cfmail/shared/flags";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import {
  ArchiveRestore,
  ArrowLeft,
  Forward,
  Inbox,
  MailMinus,
  Reply,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import type { MailView, MessageRow, ThreadRow } from "@/lib/queries.ts";
import { openCompose } from "./compose-dock.tsx";
import { LabelChips, LabelsMenu } from "./labels-menu.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";

interface Props {
  thread: ThreadRow;
  messages: MessageRow[];
  view?: MailView;
  readOnly?: boolean;
}

export function MessageView({ thread, messages, view = "inbox", readOnly = false }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["threads", thread.mailboxId] });
    qc.invalidateQueries({ queryKey: ["thread", thread.id] });
  }, [qc, thread.mailboxId, thread.id]);

  const setState = useMutation({
    mutationFn: (patch: { trashed?: boolean; spam?: boolean }) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const setMsg = useMutation({
    mutationFn: (input: { id: string; patch: { seen?: boolean; starred?: boolean } }) =>
      api(`/api/messages/${input.id}`, { method: "PATCH", body: JSON.stringify(input.patch) }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Auto-mark inbound messages as read when the thread is opened.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || markedRef.current === thread.id) return;
    const unseen = messages.filter((m) => m.direction === "in" && !hasFlag(m.flags, Flag.SEEN));
    if (unseen.length === 0) return;
    markedRef.current = thread.id;
    void Promise.all(
      unseen.map((m) =>
        api(`/api/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ seen: true }) }),
      ),
    ).then(invalidate);
  }, [thread.id, messages, readOnly, invalidate]);

  function act(patch: { trashed?: boolean; spam?: boolean }, label: string, undo: typeof patch) {
    setState.mutate(patch, {
      onSuccess: () => {
        toast.success(label, {
          action: { label: "Undo", onClick: () => setState.mutate(undo) },
        });
        nav({
          to: "/app/m/$mailboxId",
          params: { mailboxId: thread.mailboxId },
          search: { view },
        });
      },
    });
  }

  function markUnread() {
    const last = messages.findLast((m) => m.direction === "in");
    if (last) setMsg.mutate({ id: last.id, patch: { seen: false } });
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center gap-1 border-b bg-card px-2 py-2 sm:px-4">
          <Tooltip label="Back">
            <Button variant="ghost" size="icon" onClick={() => history.back()} aria-label="Back">
              <ArrowLeft />
            </Button>
          </Tooltip>
          <h1 className="flex-1 truncate font-semibold text-[14px] tracking-tight">
            {messages[0]?.subject || thread.subjectNorm || "(no subject)"}
          </h1>
          {!readOnly && messages.at(-1) && (
            <LabelsMenu mailboxId={thread.mailboxId} messageId={messages.at(-1)!.id} />
          )}
          {!readOnly && (
            <>
              <ToolbarButton
                onClick={markUnread}
                disabled={setMsg.isPending}
                label="Mark unread (u)"
              >
                <MailMinus />
              </ToolbarButton>
              {view === "trash" ? (
                <ToolbarButton
                  onClick={() => act({ trashed: false }, "Restored", { trashed: true })}
                  disabled={setState.isPending}
                  label="Restore"
                >
                  <ArchiveRestore />
                </ToolbarButton>
              ) : (
                <>
                  {view === "spam" ? (
                    <ToolbarButton
                      onClick={() => act({ spam: false }, "Moved to Inbox", { spam: true })}
                      disabled={setState.isPending}
                      label="Not spam"
                    >
                      <Inbox />
                    </ToolbarButton>
                  ) : (
                    <ToolbarButton
                      onClick={() => act({ spam: true }, "Marked as spam", { spam: false })}
                      disabled={setState.isPending}
                      label="Mark as spam (!)"
                    >
                      <ShieldAlert />
                    </ToolbarButton>
                  )}
                  <ToolbarButton
                    onClick={() => act({ trashed: true }, "Moved to Trash", { trashed: false })}
                    disabled={setState.isPending}
                    label="Trash (#)"
                  >
                    <Trash2 />
                  </ToolbarButton>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
          {messages.map((m) => (
            <MessageCard
              key={m.id}
              msg={m}
              readOnly={readOnly}
              onToggleStar={() =>
                setMsg.mutate({
                  id: m.id,
                  patch: { starred: !hasFlag(m.flags, Flag.STARRED) },
                })
              }
            />
          ))}
        </div>

        {!readOnly && (
          <div className="flex items-center gap-2 border-t bg-card p-3">
            <Button
              variant="secondary"
              onClick={() => openCompose({ replyToMessage: messages.at(-1) ?? null })}
            >
              <Reply /> Reply
            </Button>
            <Button
              variant="secondary"
              onClick={() => openCompose({ forwardMessage: messages.at(-1) ?? null })}
            >
              <Forward /> Forward
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function ToolbarButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <Button variant="ghost" size="icon" onClick={onClick} disabled={disabled} aria-label={label}>
        {children}
      </Button>
    </Tooltip>
  );
}

// Show the envelope recipient when it isn't already one of the visible To
// addresses — i.e. mail that arrived via a redirect/alias or Bcc.
function showsDeliveredTo(msg: MessageRow): boolean {
  if (msg.direction !== "in" || !msg.deliveredTo) return false;
  const to = msg.deliveredTo.trim().toLowerCase();
  return !msg.toAddrs.some((a) => a.address.trim().toLowerCase() === to);
}

function MessageCard({
  msg,
  readOnly,
  onToggleStar,
}: {
  msg: MessageRow;
  readOnly: boolean;
  onToggleStar: () => void;
}) {
  const bodyHtml = useMemo(() => {
    const html = (msg as { html?: string | null }).html ?? null;
    if (html) return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return null;
  }, [msg]);
  const starred = hasFlag(msg.flags, Flag.STARRED);
  const when = new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt);

  return (
    <article className="overflow-hidden rounded-lg border bg-card shadow-black/[0.02] shadow-sm">
      <header className="flex items-start justify-between gap-4 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="font-semibold text-[13px]">
            {msg.fromName ?? msg.fromAddr}{" "}
            <span className="font-normal text-muted-foreground">&lt;{msg.fromAddr}&gt;</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            to {msg.toAddrs.map((a) => a.name ?? a.address).join(", ")}
          </div>
          {showsDeliveredTo(msg) && (
            <Badge variant="default" className="mt-1">
              Delivered to {msg.deliveredTo}
            </Badge>
          )}
          <LabelChips messageId={msg.id} className="mt-1.5" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <time className="text-[11px] text-muted-foreground" title={when.toLocaleString()}>
            {when.toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleStar}
              className={cn(starred && "text-amber-500 hover:text-amber-500")}
              aria-label={starred ? "Unstar" : "Star"}
              aria-pressed={starred}
            >
              <Star className={cn(starred && "fill-current")} />
            </Button>
          )}
        </div>
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
