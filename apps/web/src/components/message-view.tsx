import { Flag, hasFlag, setFlag } from "@cfmail/shared/flags";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Inbox,
  MailMinus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import {
  invalidateThreadChange,
  patchMessageFlags,
  removeMessageFromThread,
  removeThreadsFromLists,
} from "@/lib/invalidate.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import type { MailView, MessageRow, ThreadRow } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { LabelsMenu } from "./labels-menu.tsx";
import { MessageCard } from "./message/message-card.tsx";
import { ThreadAiActions, ThreadAiResults, useThreadAi } from "./message/use-thread-ai.tsx";
import { MoveToFolderMenu } from "./move-to-folder-menu.tsx";
import { ReminderMenu } from "./reminder-menu.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

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

  // eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity required by the auto-mark-read effect's exhaustive-deps
  const invalidate = useCallback(
    () =>
      invalidateThreadChange(qc, {
        mailboxId: thread.mailboxId,
        threadId: thread.id,
        counts: true,
        folders: true,
      }),
    [qc, thread.mailboxId, thread.id],
  );

  // Trash/spam optimistically drops the thread from the open mailbox's lists;
  // `act()` navigates away, so the row vanishes instantly. Settle reconciles.
  const setState = useThreadListMutation<{ trashed?: boolean; spam?: boolean }>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: (patch) =>
      unwrap(rpc.threads[":id"].$patch({ param: { id: thread.id }, json: patch })),
    optimistic: (_patch, client) => removeThreadsFromLists(client, thread.mailboxId, [thread.id]),
  });

  // Permanent delete: irreversible, so no undo — confirm then drop the row.
  const del = useThreadListMutation<void>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: () => unwrap(rpc.threads[":id"].$delete({ param: { id: thread.id } })),
    optimistic: (_v, client) => removeThreadsFromLists(client, thread.mailboxId, [thread.id]),
  });

  // Permanently delete a single message out of the thread. The server drops the
  // whole thread when it was the last message — navigate away in that case,
  // otherwise just remove the card from the open thread.
  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- reconciles cache via onSettled invalidate + removeThreadsFromLists/removeMessageFromThread
  const delMsg = useMutation({
    mutationFn: (id: string) => unwrap(rpc.messages[":id"].$delete({ param: { id } })),
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
    }) => unwrap(rpc.messages[":id"].$patch({ param: { id: input.id }, json: input.patch })),
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
        unwrap(rpc.messages[":id"].$patch({ param: { id: m.id }, json: { seen: true } })),
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
      if (!card) return;
      const rect = container.getBoundingClientRect();
      const scrollTop = container.scrollTop;
      const cs = getComputedStyle(container);
      const padTop = Number.parseFloat(cs.paddingTop) || 0;
      const padBottom = Number.parseFloat(cs.paddingBottom) || 0;
      // The scroll offset at which the newest message rests at the top: just below
      // the previous message (showing only the inter-message gap), or below the
      // container padding when it leads the thread. Measured straight from layout
      // so it's exact regardless of margins/padding/subpixel rounding.
      const prev = card.previousElementSibling;
      const ref = prev
        ? prev.getBoundingClientRect().bottom
        : card.getBoundingClientRect().top - padTop;
      const target = ref - rect.top + scrollTop;
      // Size the trailing spacer so that rest offset is also the furthest you can
      // scroll, leaving no empty space below the newest message to overscroll into.
      // Derive the true content height from the spacer's own rect — scrollHeight is
      // clamped to clientHeight when the whole thread already fits in the viewport.
      if (spacer) {
        const contentBottom =
          spacer.getBoundingClientRect().bottom - rect.top + scrollTop + padBottom;
        const room = Math.max(
          0,
          spacer.offsetHeight + target + container.clientHeight - contentBottom,
        );
        if (Math.abs(spacer.offsetHeight - room) > 0.5) spacer.style.height = `${room}px`;
      }
      if (pinned) container.scrollTop = target;
    };
    align();
    // A resize can fire one callback per observed child in a single frame;
    // coalesce them into a single align() on the next animation frame so the
    // layout reads/writes run once, not once per message.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        align();
      });
    };
    const ro = new ResizeObserver(schedule);
    // The spacer is sized by `align`; observing it would feed its own resize
    // back in, so only watch the message cards.
    for (const child of Array.from(container.children))
      if (child !== spacerRef.current) ro.observe(child);
    const release = () => {
      pinned = false;
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
    const opts: AddEventListenerOptions = { passive: true };
    container.addEventListener("wheel", release, opts);
    container.addEventListener("touchstart", release, opts);
    container.addEventListener("keydown", release);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      container.removeEventListener("wheel", release, opts);
      container.removeEventListener("touchstart", release, opts);
      container.removeEventListener("keydown", release);
    };
  }, [thread.id]);

  // Side nav arrows: "up" reveals older messages, "down" returns to the newest.
  // Each shows only while there's room to travel that way.
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind when a new thread opens
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () => {
      setCanUp(container.scrollTop > 8);
      setCanDown(container.scrollTop < container.scrollHeight - container.clientHeight - 8);
    };
    // eslint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- reads live scroll offsets from the DOM; not derivable during render
    update();
    const opts: AddEventListenerOptions = { passive: true };
    container.addEventListener("scroll", update, opts);
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => {
      container.removeEventListener("scroll", update, opts);
      ro.disconnect();
    };
  }, [thread.id]);
  const scrollTo = (top: number) => scrollRef.current?.scrollTo({ top, behavior: "smooth" });

  // Individually-trashed messages are hidden from the active folders. The Trash
  // view shows the whole conversation when the thread itself is trashed, else
  // only its deleted messages; "All" shows everything.
  const visibleMessages =
    view === "trash"
      ? thread.trashed
        ? messages
        : messages.filter((m) => hasFlag(m.flags, Flag.TRASH))
      : view === "all"
        ? messages
        : messages.filter((m) => !hasFlag(m.flags, Flag.TRASH));

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

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3 sm:space-y-4 sm:p-4">
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
          {canUp && (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Older messages"
              onClick={() => scrollTo(0)}
              className="absolute top-2 right-3 z-10 rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
            >
              <ChevronUp />
            </Button>
          )}
          {canDown && (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Newest message"
              onClick={() => scrollTo(scrollRef.current?.scrollHeight ?? 0)}
              className="absolute right-3 bottom-2 z-10 rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
            >
              <ChevronDown />
            </Button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
