import { Flag, hasFlag, setFlag } from "@cfmail/shared/flags";
import type { UnsubscribeResultDto } from "@cfmail/shared/responses";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveRestore,
  ArrowLeft,
  Forward,
  Inbox,
  MailMinus,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import {
  invalidateThreadChange,
  patchMessageFlags,
  removeThreadsFromLists,
} from "@/lib/invalidate.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import type { MailView, MessageRow, ThreadRow } from "@/lib/queries.ts";
import { messageBodyQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { openCompose } from "./compose-dock.tsx";
import { EmailFrame } from "./email-frame.tsx";
import { LabelChips, LabelsMenu } from "./labels-menu.tsx";
import { MoveToFolderMenu } from "./move-to-folder-menu.tsx";
import { Button } from "./ui/button.tsx";
import { IconButton } from "./ui/icon-button.tsx";
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

  const invalidate = useCallback(
    () => invalidateThreadChange(qc, thread.mailboxId, thread.id),
    [qc, thread.mailboxId, thread.id],
  );

  // Trash/spam optimistically drops the thread from the open mailbox's lists;
  // `act()` navigates away, so the row vanishes instantly. Settle reconciles.
  const setState = useThreadListMutation<{ trashed?: boolean; spam?: boolean }>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: (patch) =>
      api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    optimistic: (_patch, client) => removeThreadsFromLists(client, thread.mailboxId, [thread.id]),
  });

  const setMsg = useMutation({
    mutationFn: (input: { id: string; patch: { seen?: boolean; starred?: boolean } }) =>
      api(`/api/messages/${input.id}`, { method: "PATCH", body: JSON.stringify(input.patch) }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.thread(thread.id) });
      const prev = qc.getQueryData<{ messages: MessageRow[] }>(keys.thread(thread.id));
      const current = prev?.messages.find((m) => m.id === id);
      if (current) {
        let flags = current.flags;
        if (patch.seen !== undefined) flags = setFlag(flags, Flag.SEEN, patch.seen);
        if (patch.starred !== undefined) flags = setFlag(flags, Flag.STARRED, patch.starred);
        patchMessageFlags(qc, thread.id, id, flags);
      }
      return { prev };
    },
    onError: (e: unknown, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.thread(thread.id), ctx.prev);
      toast.error(e instanceof Error ? e.message : "Failed");
    },
    onSettled: invalidate,
  });

  // Auto-mark inbound messages as read when the thread is opened.
  const { prefs } = useUserPrefs();
  const autoMarkRead = prefs.autoMarkRead !== false;
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || !autoMarkRead || markedRef.current === thread.id) return;
    const unseen = messages.filter((m) => m.direction === "in" && !hasFlag(m.flags, Flag.SEEN));
    if (unseen.length === 0) return;
    markedRef.current = thread.id;
    void Promise.all(
      unseen.map((m) =>
        api(`/api/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ seen: true }) }),
      ),
    ).then(invalidate);
  }, [thread.id, messages, readOnly, autoMarkRead, invalidate]);

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
        <div className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2 sm:px-4">
          <IconButton icon={ArrowLeft} label="Back" onClick={() => history.back()} />
          <h1 className="flex-1 truncate font-semibold text-[14px] tracking-tight">
            {messages[0]?.subject || thread.subjectNorm || "(no subject)"}
          </h1>
          {!readOnly && messages.at(-1) && (
            <LabelsMenu mailboxId={thread.mailboxId} messageId={messages.at(-1)!.id} />
          )}
          {!readOnly && (
            <MoveToFolderMenu
              threadId={thread.id}
              mailboxId={thread.mailboxId}
              onMoved={(folderName) => {
                toast.success(`Moved to ${folderName}`);
                nav({
                  to: "/app/m/$mailboxId",
                  params: { mailboxId: thread.mailboxId },
                  search: { view },
                });
              }}
            />
          )}
          {!readOnly && (
            <>
              <IconButton
                icon={MailMinus}
                onClick={markUnread}
                disabled={setMsg.isPending}
                label="Mark unread (u)"
              />
              {view === "trash" ? (
                <IconButton
                  icon={ArchiveRestore}
                  onClick={() => act({ trashed: false }, "Restored", { trashed: true })}
                  disabled={setState.isPending}
                  label="Restore"
                />
              ) : (
                <>
                  {view === "spam" ? (
                    <IconButton
                      icon={Inbox}
                      onClick={() => act({ spam: false }, "Moved to Inbox", { spam: true })}
                      disabled={setState.isPending}
                      label="Not spam"
                    />
                  ) : (
                    <IconButton
                      icon={ShieldAlert}
                      onClick={() => act({ spam: true }, "Marked as spam", { spam: false })}
                      disabled={setState.isPending}
                      label="Mark as spam (!)"
                    />
                  )}
                  <IconButton
                    icon={Trash2}
                    onClick={() => act({ trashed: true }, "Moved to Trash", { trashed: false })}
                    disabled={setState.isPending}
                    label="Trash (#)"
                  />
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
      </div>
    </TooltipProvider>
  );
}

// Interpret the parsed Authentication-Results summary. "fail" means the sender
// is likely forged; "unverified" means we couldn't confirm it (no/none auth).
function authStatus(auth: MessageRow["spamAuth"]): "pass" | "fail" | "unverified" | null {
  if (!auth) return null;
  if (auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass")) return "pass";
  if (auth.dmarc === "fail" || (auth.spf === "fail" && auth.dkim === "fail")) return "fail";
  if (!auth.spf && !auth.dkim && !auth.dmarc) return null;
  return "unverified";
}

function SpamBanner({ msg }: { msg: MessageRow }) {
  if (msg.direction !== "in") return null;
  const verdict = msg.spamVerdict;
  const auth = authStatus(msg.spamAuth);
  const flagged = verdict === "spam" || verdict === "suspicious";
  // Surface a sender-authentication warning even when the message wasn't
  // classified as spam — a spoofed From must not be rendered as trusted.
  if (!flagged && auth !== "fail") return null;

  const reasons = [...(msg.spamReasons ?? [])];
  if (auth === "fail" && !reasons.length) {
    reasons.push("The sender's address could not be verified — it may be forged (spoofed).");
  }
  const isSpam = verdict === "spam";
  const title = isSpam
    ? "This message was flagged as spam"
    : verdict === "suspicious"
      ? "This message looks suspicious"
      : "Could not verify this sender";
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b px-4 py-2.5 text-[12px]",
        isSpam
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div>
        <div className="font-semibold">{title}</div>
        {reasons.length > 0 && (
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Newsletters carry a List-Unsubscribe header; surface a one-tap opt-out. The
// worker decides the channel (one-click POST / mailto / link) — a "link" result
// is an https page we open in a new tab, everything else is handled server-side.
function UnsubscribeBanner({ msg, readOnly }: { msg: MessageRow; readOnly: boolean }) {
  const [done, setDone] = useState(false);
  const unsub = useMutation({
    mutationFn: () =>
      api<UnsubscribeResultDto>(`/api/messages/${msg.id}/unsubscribe`, { method: "POST" }),
    onSuccess: (res) => {
      if (res.status === "open" && res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
        return;
      }
      setDone(true);
      toast.success("Unsubscribe request sent");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to unsubscribe"),
  });

  if (msg.direction !== "in" || !msg.listUnsubscribe) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b bg-muted/60 px-4 py-2 text-[12px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <MailMinus className="size-4 shrink-0" />
        <span className="truncate">
          {done ? "Unsubscribe request sent." : "This is a newsletter."}
        </span>
      </div>
      {!readOnly && !done && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => unsub.mutate()}
          disabled={unsub.isPending}
        >
          {unsub.isPending ? "Unsubscribing…" : "Unsubscribe"}
        </Button>
      )}
    </div>
  );
}

function addrList(list: { name?: string; address: string }[]): string {
  return list.map((a) => a.name ?? a.address).join(", ");
}

// Reply / reply-all / forward, grouped as a single segmented control.
function MessageActions({ msg }: { msg: MessageRow }) {
  return (
    <div className="flex items-center overflow-hidden rounded-lg border bg-background shadow-black/[0.03] shadow-sm">
      <ActionIcon label="Reply" onClick={() => openCompose({ replyToMessage: msg })}>
        <Reply />
      </ActionIcon>
      <span className="h-5 w-px bg-border" />
      <ActionIcon
        label="Reply all"
        onClick={() => openCompose({ replyToMessage: msg, replyAll: true })}
      >
        <ReplyAll />
      </ActionIcon>
      <span className="h-5 w-px bg-border" />
      <ActionIcon label="Forward" onClick={() => openCompose({ forwardMessage: msg })}>
        <Forward />
      </ActionIcon>
    </div>
  );
}

function ActionIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="grid size-8 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none [&_svg]:size-4"
      >
        {children}
      </button>
    </Tooltip>
  );
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
  // The body isn't in the thread payload (listing only carries the snippet);
  // fetch the full parsed body lazily when the card mounts.
  const body = useQuery(messageBodyQuery(msg.id));
  const bodyHtml = useMemo(() => {
    const html = body.data?.html;
    return html ? sanitizeEmailHtml(html) : null;
  }, [body.data?.html]);
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
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <div>
              <span className="text-muted-foreground/70">to</span> {addrList(msg.toAddrs)}
            </div>
            {msg.ccAddrs && msg.ccAddrs.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">cc</span> {addrList(msg.ccAddrs)}
              </div>
            )}
            {msg.bccAddrs && msg.bccAddrs.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">bcc</span> {addrList(msg.bccAddrs)}
              </div>
            )}
          </div>
          <LabelChips messageId={msg.id} className="mt-1.5" />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
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
          {!readOnly && <MessageActions msg={msg} />}
        </div>
      </header>
      <SpamBanner msg={msg} />
      <UnsubscribeBanner msg={msg} readOnly={readOnly} />
      {bodyHtml ? (
        // Untrusted HTML renders in a sandboxed, scriptless iframe so a
        // sanitizer bypass can't reach the app origin or the session.
        <EmailFrame html={bodyHtml} />
      ) : (
        // Plain-text body once loaded; the snippet shows while the body is in
        // flight (or if parsing yields neither html nor text).
        <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-[13px]">
          {body.data?.text ?? msg.snippet}
        </pre>
      )}
    </article>
  );
}
