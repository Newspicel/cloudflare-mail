import { Flag, hasFlag, setFlag } from "@cfmail/shared/flags";
import type {
  AttachmentDto,
  CalendarEventDto,
  SmartReplyDto,
  ThreadSummaryDto,
  UnsubscribeResultDto,
  UserPrefs,
} from "@cfmail/shared/responses";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  ArchiveRestore,
  ArrowLeft,
  CalendarClock,
  CalendarX2,
  Download,
  Forward,
  Inbox,
  Loader2,
  Lock,
  LockOpen,
  MailMinus,
  MapPin,
  MessageSquareReply,
  Paperclip,
  Repeat,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Star,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import {
  invalidateThreadChange,
  patchMessageFlags,
  removeMessageFromThread,
  removeThreadsFromLists,
} from "@/lib/invalidate.ts";
import { linkifyText } from "@/lib/linkify.tsx";
import { useDateTimeFmt, useUserPrefs } from "@/lib/prefs.ts";
import type { MailView, MessageRow, ThreadRow } from "@/lib/queries.ts";
import { mailboxesQuery, messageBodyQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { type DateTimeFmt, formatClock, formatDateTime } from "@/lib/time.ts";
import { openCompose } from "./compose-dock.tsx";
import { EmailFrame } from "./email-frame.tsx";
import { LabelChips, LabelsMenu } from "./labels-menu.tsx";
import { MessageMenu } from "./message-menu.tsx";
import { MoveToFolderMenu } from "./move-to-folder-menu.tsx";
import { ReminderMenu } from "./reminder-menu.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";

interface Props {
  thread: ThreadRow;
  messages: MessageRow[];
  view?: MailView;
  readOnly?: boolean;
  // Set when the thread is being viewed inside a custom folder, enabling the
  // "move back to mailbox" action in the move-to-folder menu.
  folderId?: string;
}

export function MessageView({
  thread,
  messages,
  view = "inbox",
  readOnly = false,
  folderId,
}: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { confirmDelete } = useConfirmHelpers();

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

  // Permanent delete: irreversible, so no undo — confirm then drop the row.
  const del = useThreadListMutation<void>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: () => api(`/api/threads/${thread.id}`, { method: "DELETE" }),
    optimistic: (_v, client) => removeThreadsFromLists(client, thread.mailboxId, [thread.id]),
  });

  // Permanently delete a single message out of the thread. The server drops the
  // whole thread when it was the last message — navigate away in that case,
  // otherwise just remove the card from the open thread.
  const delMsg = useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: boolean; threadDeleted: boolean }>(`/api/messages/${id}`, {
        method: "DELETE",
      }),
    onSuccess: (res, id) => {
      toast.success("Message deleted");
      if (res.threadDeleted) {
        removeThreadsFromLists(qc, thread.mailboxId, [thread.id]);
        nav({
          to: "/app/m/$mailboxId",
          params: { mailboxId: thread.mailboxId },
          search: { view },
        });
      } else {
        removeMessageFromThread(qc, thread.id, id);
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
    onSettled: invalidate,
  });

  async function removeMessage(id: string) {
    // The thread's last message — deleting it drops the whole conversation.
    const subject = messages.length <= 1 ? "this conversation" : "this message";
    if (!(await confirmDelete(subject))) return;
    delMsg.mutate(id);
  }

  const setMsg = useMutation({
    mutationFn: (input: {
      id: string;
      patch: { seen?: boolean; starred?: boolean; trash?: boolean };
    }) => api(`/api/messages/${input.id}`, { method: "PATCH", body: JSON.stringify(input.patch) }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.thread(thread.id) });
      const prev = qc.getQueryData<{ messages: MessageRow[] }>(keys.thread(thread.id));
      const current = prev?.messages.find((m) => m.id === id);
      if (current) {
        let flags = current.flags;
        if (patch.seen !== undefined) flags = setFlag(flags, Flag.SEEN, patch.seen);
        if (patch.starred !== undefined) flags = setFlag(flags, Flag.STARRED, patch.starred);
        // Trashing/restoring flips Flag.TRASH; the message then drops in or out of
        // the visible list (which filters on it) for instant feedback.
        if (patch.trash !== undefined) flags = setFlag(flags, Flag.TRASH, patch.trash);
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

  function trashMessage(id: string) {
    setMsg.mutate(
      { id, patch: { trash: true } },
      {
        onSuccess: () =>
          toast.success("Message deleted", {
            action: {
              label: "Undo",
              onClick: () => setMsg.mutate({ id, patch: { trash: false } }),
            },
          }),
      },
    );
  }

  function restoreMessage(id: string) {
    setMsg.mutate({ id, patch: { trash: false } }, { onSuccess: () => toast.success("Restored") });
  }

  // Auto-mark inbound messages as read when the thread is opened.
  const { prefs } = useUserPrefs();
  const autoMarkRead = prefs.autoMarkRead !== false;
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || !autoMarkRead || markedRef.current === thread.id) return;
    const unseen = messages.filter(
      (m) => m.direction === "in" && !hasFlag(m.flags, Flag.SEEN) && !hasFlag(m.flags, Flag.TRASH),
    );
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

  async function remove() {
    if (!(await confirmDelete("this conversation"))) return;
    del.mutate(undefined, {
      onSuccess: () => {
        toast.success("Deleted permanently");
        nav({
          to: "/app/m/$mailboxId",
          params: { mailboxId: thread.mailboxId },
          search: { view },
        });
      },
    });
  }

  function markUnread() {
    const last = messages.findLast((m) => m.direction === "in" && !hasFlag(m.flags, Flag.TRASH));
    if (last) setMsg.mutate({ id: last.id, patch: { seen: false } });
  }

  // Open a thread positioned at the newest message's header, and keep it pinned
  // there while older messages' bodies stream in (their height changes shift the
  // anchor) — until the user scrolls, after which we leave the position alone.
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCardRef = useRef<HTMLElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin when a new thread opens
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let pinned = true;
    const align = () => {
      const card = lastCardRef.current;
      const spacer = spacerRef.current;
      // Keep the container's top padding visible above the newest message
      // instead of scrolling the card flush against the border.
      const padTop = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
      // Grow a trailing spacer so the newest message can always be scrolled to
      // the top — a short last message has no content below it to push against,
      // otherwise it'd sit mid-viewport instead of leading the thread.
      if (spacer && card) {
        const room = Math.max(0, container.clientHeight - card.offsetHeight - padTop);
        if (spacer.offsetHeight !== room) spacer.style.height = `${room}px`;
      }
      if (!pinned || !card) return;
      // Land the newest card just below the previous message (showing only the
      // inter-message gap), or below the container padding when it's the first.
      const prev = card.previousElementSibling;
      const top = prev
        ? prev.getBoundingClientRect().bottom
        : container.getBoundingClientRect().top + padTop;
      container.scrollTop += top - container.getBoundingClientRect().top;
    };
    align();
    const ro = new ResizeObserver(align);
    // The spacer is sized by `align`; observing it would feed its own resize
    // back in, so only watch the message cards.
    for (const child of Array.from(container.children))
      if (child !== spacerRef.current) ro.observe(child);
    const release = () => {
      pinned = false;
      ro.disconnect();
    };
    const opts: AddEventListenerOptions = { passive: true };
    container.addEventListener("wheel", release, opts);
    container.addEventListener("touchstart", release, opts);
    container.addEventListener("keydown", release);
    return () => {
      ro.disconnect();
      container.removeEventListener("wheel", release, opts);
      container.removeEventListener("touchstart", release, opts);
      container.removeEventListener("keydown", release);
    };
  }, [thread.id]);

  // Individually-trashed messages are hidden from the active folders. The Trash
  // view shows the whole conversation when the thread itself is trashed, else
  // only its deleted messages; "All" shows everything.
  const visibleMessages = useMemo(() => {
    if (view === "trash")
      return thread.trashed ? messages : messages.filter((m) => hasFlag(m.flags, Flag.TRASH));
    if (view === "all") return messages;
    return messages.filter((m) => !hasFlag(m.flags, Flag.TRASH));
  }, [messages, view, thread.trashed]);

  const ai = useThreadAi(thread, visibleMessages);

  // Per-message actions depend on its state: a trashed message can be restored or
  // permanently deleted; a live message in a trashed thread can only be purged;
  // otherwise it can be soft-deleted into the Trash.
  function messageActions(m: MessageRow) {
    if (readOnly) return {};
    if (hasFlag(m.flags, Flag.TRASH))
      return { onRestore: () => restoreMessage(m.id), onDelete: () => removeMessage(m.id) };
    if (thread.trashed) return { onDelete: () => removeMessage(m.id) };
    return { onTrash: () => trashMessage(m.id) };
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2 sm:px-4">
          <IconButton icon={ArrowLeft} label="Back" onClick={() => history.back()} />
          <h1 className="flex-1 truncate font-semibold text-[14px] tracking-tight">
            {messages[0]?.subject || thread.subjectNorm || "(no subject)"}
          </h1>
          {!readOnly && ai.aiOn && <ThreadAiActions ai={ai} />}
          {!readOnly && messages.at(-1) && (
            <LabelsMenu
              mailboxId={thread.mailboxId}
              messageId={messages.at(-1)!.id}
              tooltip="Labels"
            />
          )}
          {!readOnly && (
            <ReminderMenu
              threadId={thread.id}
              mailboxId={thread.mailboxId}
              messageId={messages.at(-1)?.id}
            />
          )}
          {!readOnly && (
            <MoveToFolderMenu
              threadIds={[thread.id]}
              mailboxId={thread.mailboxId}
              currentFolderId={folderId}
              tooltip="Move to folder"
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
                <>
                  <IconButton
                    icon={ArchiveRestore}
                    onClick={() => act({ trashed: false }, "Restored", { trashed: true })}
                    disabled={setState.isPending}
                    label="Restore"
                  />
                  <IconButton
                    icon={Trash2}
                    onClick={remove}
                    disabled={del.isPending}
                    label="Delete permanently"
                    className="hover:bg-destructive/10 hover:text-destructive"
                  />
                </>
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
                      className="hover:bg-yellow-500/10 hover:text-yellow-600 dark:hover:text-yellow-500"
                    />
                  )}
                  <IconButton
                    icon={Trash2}
                    onClick={() => act({ trashed: true }, "Moved to Trash", { trashed: false })}
                    disabled={setState.isPending}
                    label="Trash (#)"
                    className="hover:bg-destructive/10 hover:text-destructive"
                  />
                </>
              )}
            </>
          )}
        </div>

        {!readOnly && ai.aiOn && <ThreadAiResults ai={ai} />}

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
          {visibleMessages.map((m, i) => (
            <MessageCard
              key={m.id}
              cardRef={i === visibleMessages.length - 1 ? lastCardRef : undefined}
              msg={m}
              readOnly={readOnly}
              busy={setMsg.isPending || delMsg.isPending}
              {...messageActions(m)}
              onToggleStar={() =>
                setMsg.mutate({
                  id: m.id,
                  patch: { starred: !hasFlag(m.flags, Flag.STARRED) },
                })
              }
            />
          ))}
          <div ref={spacerRef} aria-hidden className="shrink-0" />
        </div>
      </div>
    </TooltipProvider>
  );
}

// AI helpers for an open thread: a one-tap thread summary and smart-reply
// suggestions for the latest inbound message. The triggers live in the thread
// top bar (always visible) while results render just below it. Mutations reset
// on thread change since MessageView stays mounted across threads. Both calls
// are best-effort and degrade to a toast.
type ThreadAi = ReturnType<typeof useThreadAi>;

function useThreadAi(thread: ThreadRow, messages: MessageRow[]) {
  const { data: mbData } = useQuery(mailboxesQuery);
  const aiOn = mbData?.mailboxes.find((m) => m.id === thread.mailboxId)?.aiFeatures ?? false;
  const lastInbound = useMemo(
    () => [...messages].toReversed().find((m) => m.direction === "in"),
    [messages],
  );

  const summarize = useMutation({
    mutationFn: () =>
      api<ThreadSummaryDto>(`/api/threads/${thread.id}/summary`, { method: "POST" }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't summarize"),
  });
  const smartReply = useMutation({
    mutationFn: () =>
      api<SmartReplyDto>(`/api/messages/${lastInbound!.id}/smart-reply`, { method: "POST" }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't draft replies"),
  });

  const reset = summarize.reset;
  const resetReply = smartReply.reset;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on thread switch
  useEffect(() => {
    reset();
    resetReply();
  }, [thread.id, reset, resetReply]);

  return { aiOn, lastInbound, summarize, smartReply };
}

function ThreadAiActions({ ai }: { ai: ThreadAi }) {
  const { lastInbound, summarize, smartReply } = ai;
  return (
    <>
      <IconButton
        icon={summarize.isPending ? Loader2 : Sparkles}
        onClick={() => summarize.mutate()}
        disabled={summarize.isPending}
        label={summarize.isPending ? "Summarizing…" : "Summarize thread"}
        className={summarize.isPending ? "[&_svg]:animate-spin" : undefined}
      />
      {lastInbound && (
        <IconButton
          icon={smartReply.isPending ? Loader2 : MessageSquareReply}
          onClick={() => smartReply.mutate()}
          disabled={smartReply.isPending}
          label={smartReply.isPending ? "Drafting…" : "Suggest replies"}
          className={smartReply.isPending ? "[&_svg]:animate-spin" : undefined}
        />
      )}
    </>
  );
}

function ThreadAiResults({ ai }: { ai: ThreadAi }) {
  const { lastInbound, summarize, smartReply } = ai;
  if (!summarize.isSuccess && !smartReply.isSuccess) return null;

  const bullets = summarize.data?.bullets ?? [];
  const suggestions = smartReply.data?.suggestions ?? [];

  return (
    <div className="shrink-0 space-y-2 border-b bg-muted/30 px-3 py-2.5 text-[13px] sm:px-4">
      {summarize.isSuccess && (
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {bullets.length ? (
              bullets.map((b) => <li key={b}>{b}</li>)
            ) : (
              <li className="list-none">No summary available.</li>
            )}
          </ul>
        </div>
      )}
      {smartReply.isSuccess && lastInbound && (
        <div className="flex flex-col gap-1.5">
          {suggestions.length ? (
            suggestions.map((sug) => (
              <button
                key={sug}
                type="button"
                className="rounded-md border bg-card px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => openCompose({ replyToMessage: lastInbound, initialBody: sug })}
              >
                {sug}
              </button>
            ))
          ) : (
            <span className="text-muted-foreground">No suggestions available.</span>
          )}
        </div>
      )}
    </div>
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

// A single Proton-style padlock shown in front of the sender, folding the
// strongest available trust signal into one glyph: end-to-end PGP encryption,
// PGP signature verification, then transport authentication (SPF/DKIM/DMARC).
type LockTone = "success" | "warning" | "destructive" | "muted";

const LOCK_TONES: Record<LockTone, string> = {
  success: "text-success",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function senderLock(
  msg: MessageRow,
): { Icon: LucideIcon; tone: LockTone; title: string; detail?: string } | null {
  const inbound = msg.direction === "in";

  // 1. PGP encryption — end-to-end, the strongest signal.
  if (msg.pgpEncrypted) {
    if (inbound && msg.pgpSigned && msg.pgpVerify === "bad")
      return {
        Icon: Lock,
        tone: "destructive",
        title: "Encrypted · bad signature",
        detail: "End-to-end encrypted, but the sender's signature failed to verify.",
      };
    const detail = !msg.pgpSigned
      ? undefined
      : !inbound
        ? "Signed with your key."
        : msg.pgpVerify === "good"
          ? "Signed and verified."
          : "Signed, but the signature could not be verified.";
    return { Icon: Lock, tone: "success", title: "End-to-end encrypted", detail };
  }

  // 2. PGP signature without encryption.
  if (msg.pgpSigned) {
    if (!inbound)
      return {
        Icon: ShieldCheck,
        tone: "success",
        title: "Digitally signed",
        detail: "Signed with your key.",
      };
    if (msg.pgpVerify === "good")
      return {
        Icon: ShieldCheck,
        tone: "success",
        title: "Signed — verified",
        detail: "The sender's PGP signature is valid.",
      };
    if (msg.pgpVerify === "bad")
      return {
        Icon: ShieldAlert,
        tone: "destructive",
        title: "Bad signature",
        detail: "The PGP signature is invalid — this message may be forged.",
      };
    return {
      Icon: ShieldQuestion,
      tone: "warning",
      title: "Signed · unverified",
      detail: "Signed, but we have no key to verify the signature.",
    };
  }

  // 3. Transport authentication (inbound only) — SPF / DKIM / DMARC.
  if (inbound) {
    const auth = authStatus(msg.spamAuth);
    if (auth === "pass")
      return {
        Icon: ShieldCheck,
        tone: "muted",
        title: "Authenticated sender",
        detail: "Passed SPF / DKIM / DMARC checks.",
      };
    if (auth === "fail")
      return {
        Icon: LockOpen,
        tone: "destructive",
        title: "Unverified sender",
        detail: "Failed authentication — the address may be spoofed.",
      };
    if (auth === "unverified")
      return {
        Icon: ShieldQuestion,
        tone: "muted",
        title: "Not authenticated",
        detail: "The sender's domain isn't authenticated.",
      };
  }

  return null;
}

function SenderLock({ msg }: { msg: MessageRow }) {
  const lock = senderLock(msg);
  if (!lock) return null;
  const { Icon, tone, title, detail } = lock;
  return (
    <Tooltip label={detail ? `${title} — ${detail}` : title}>
      <span className={cn("inline-grid shrink-0 place-items-center", LOCK_TONES[tone])}>
        <Icon className="size-3.5" aria-label={title} />
      </span>
    </Tooltip>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Real (non-inline) attachments, shown below the body with a download link.
// Inline `cid:` parts are embedded in the HTML and rewritten by the body
// endpoint, so they're filtered out here to avoid duplicating them.
function MessageAttachments({
  messageId,
  attachments,
  hasHtml,
}: {
  messageId: string;
  attachments: AttachmentDto[];
  hasHtml: boolean;
}) {
  const visible = attachments.filter((a) => !(hasHtml && a.inline && a.contentId));
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t bg-muted/30 px-4 py-3">
      {visible.map((att) => (
        <a
          key={att.id}
          href={`/api/messages/${messageId}/attachments/${att.id}/raw?download`}
          download={att.filename}
          className="group flex max-w-full items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-left shadow-black/[0.02] shadow-sm transition-colors hover:border-primary/40 hover:bg-muted"
        >
          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-[12px]">{att.filename}</span>
            <span className="block text-[11px] text-muted-foreground">
              {formatBytes(att.sizeBytes)}
            </span>
          </span>
          <Download className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </a>
      ))}
    </div>
  );
}

// Render a calendar invite's start/end window. All-day events show the date(s)
// only; timed events show the day plus a start–end time range.
function formatEventWhen(event: CalendarEventDto, fmt: DateTimeFmt): string | null {
  if (!event.start) return null;
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return null;
  const end = event.end ? new Date(event.end) : null;
  const endValid = end && !Number.isNaN(end.getTime());

  const day = start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (event.allDay) return day;

  const from = formatClock(start, fmt);
  if (!endValid) return `${day} · ${from}`;
  const sameDay = start.toDateString() === end.toDateString();
  const to = sameDay ? formatClock(end, fmt) : formatDateTime(end, fmt);
  return `${day} · ${from} – ${to}`;
}

// Build a maps deep link for an address. "auto" picks Apple Maps on Apple
// devices (where it opens the native app) and Google Maps everywhere else.
function mapsUrl(address: string, provider: UserPrefs["mapProvider"]): string {
  const q = encodeURIComponent(address);
  const apple =
    provider === "apple" ||
    (provider !== "google" &&
      typeof navigator !== "undefined" &&
      /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent));
  return apple
    ? `https://maps.apple.com/?q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// Banner for a message carrying an iCalendar invite (Invitation.ics / event.ics).
// Display-only: we surface the event details; we don't RSVP or manage a calendar.
function CalendarBanner({ event }: { event: CalendarEventDto }) {
  const fmt = useDateTimeFmt();
  const { prefs } = useUserPrefs();
  const when = formatEventWhen(event, fmt);
  const cancelled = event.method === "CANCEL";
  const isReply = event.method === "REPLY";
  const label = cancelled
    ? "Event cancelled"
    : isReply
      ? "Invitation response"
      : "Calendar invitation";
  const attendees = event.attendees.filter((a) => a.email || a.name);

  return (
    <div
      className={cn(
        "border-b px-4 py-3 text-[12px]",
        cancelled
          ? "bg-destructive/10 text-destructive"
          : "bg-primary/5 text-foreground dark:bg-primary/10",
      )}
    >
      <div className="flex items-start gap-2.5">
        {cancelled ? (
          <CalendarX2 className="mt-0.5 size-4 shrink-0" />
        ) : (
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground">
              {label}
            </span>
          </div>
          <div className={cn("font-semibold text-[14px]", cancelled && "line-through")}>
            {event.summary || "(no title)"}
          </div>
          {when && (
            <div className="text-muted-foreground">
              {when}
              {event.rrule && (
                <span className="ml-1.5 inline-flex items-center gap-1">
                  <Repeat className="size-3" /> Repeats
                </span>
              )}
            </div>
          )}
          {event.location && (
            <a
              href={mapsUrl(event.location, prefs.mapProvider)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
              title={`Open in ${prefs.mapProvider === "apple" ? "Apple Maps" : prefs.mapProvider === "google" ? "Google Maps" : "Maps"}`}
            >
              <MapPin className="size-3.5 shrink-0" />
              <span className="truncate">{event.location}</span>
            </a>
          )}
          {event.organizer && (event.organizer.name || event.organizer.email) && (
            <div className="text-muted-foreground">
              <span className="text-muted-foreground/70">Organizer:</span>{" "}
              {event.organizer.name ?? event.organizer.email}
            </div>
          )}
          {attendees.length > 0 && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="size-3.5 shrink-0" />
              <span className="truncate">
                {attendees.length} {attendees.length === 1 ? "guest" : "guests"}
              </span>
            </div>
          )}
          {!cancelled && event.meetingUrl && (
            <a
              href={event.meetingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-medium text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Video className="size-3.5 shrink-0" />
              Join meeting
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageCard({
  msg,
  cardRef,
  readOnly,
  onTrash,
  onRestore,
  onDelete,
  busy,
  onToggleStar,
}: {
  msg: MessageRow;
  cardRef?: React.Ref<HTMLElement>;
  readOnly: boolean;
  onTrash?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  busy?: boolean;
  onToggleStar: () => void;
}) {
  // The body isn't in the thread payload (listing only carries the snippet);
  // fetch the full parsed body lazily when the card mounts.
  const body = useQuery(messageBodyQuery(msg.id));
  const fmt = useDateTimeFmt();
  const bodyHtml = useMemo(() => {
    const html = body.data?.html;
    return html ? sanitizeEmailHtml(html) : null;
  }, [body.data?.html]);
  const starred = hasFlag(msg.flags, Flag.STARRED);
  const when = new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt);

  return (
    <article
      ref={cardRef}
      className="overflow-hidden rounded-lg border bg-card shadow-black/[0.02] shadow-sm"
    >
      <header className="flex items-start justify-between gap-4 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-[13px]">
            <SenderLock msg={msg} />
            <span className="truncate">
              {msg.fromName ?? msg.fromAddr}{" "}
              <span className="font-normal text-muted-foreground">&lt;{msg.fromAddr}&gt;</span>
            </span>
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
            <time
              className="text-[11px] text-muted-foreground"
              title={when.toLocaleString(undefined, { hour12: fmt.hour12 })}
            >
              {formatDateTime(when, fmt)}
            </time>
            {!readOnly && (
              <Tooltip label={starred ? "Unstar" : "Star"}>
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
              </Tooltip>
            )}
            <MessageMenu
              msg={msg}
              body={body.data}
              onTrash={onTrash}
              onRestore={onRestore}
              onDelete={onDelete}
              busy={busy}
            />
          </div>
          {!readOnly && <MessageActions msg={msg} />}
        </div>
      </header>
      <SpamBanner msg={msg} />
      <UnsubscribeBanner msg={msg} readOnly={readOnly} />
      {body.data?.calendar && <CalendarBanner event={body.data.calendar} />}
      {body.isPending ? (
        // Hold the space with a skeleton while the body loads. Rendering the
        // snippet here flashed a plain-text preview that then got replaced by the
        // HTML frame — the "text first, then HTML" lag.
        <div className="space-y-2 px-4 py-3" aria-hidden>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
      ) : bodyHtml ? (
        // Untrusted HTML renders in a sandboxed, scriptless iframe so a
        // sanitizer bypass can't reach the app origin or the session.
        <EmailFrame html={bodyHtml} />
      ) : (
        // Plain-text body once loaded (or the snippet if parsing yields neither).
        <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-[13px]">
          {linkifyText(body.data?.text ?? msg.snippet)}
        </pre>
      )}
      {body.data?.attachments && body.data.attachments.length > 0 && (
        <MessageAttachments
          messageId={msg.id}
          attachments={body.data.attachments}
          hasHtml={Boolean(bodyHtml)}
        />
      )}
    </article>
  );
}
