import { Flag, hasFlag, setFlag } from "@cfmail/shared/flags";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Inbox,
  MailMinus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import {
  invalidateThreadChange,
  patchMessageFlags,
  removeMessageFromThread,
  removeThreadsFromLists,
} from "@/lib/invalidate.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import { listSearch, type MailView, type MessageRow, type ThreadRow } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { LabelsMenu } from "./labels-menu.tsx";
import { CollapsedMessage, MessageCard } from "./message/message-card.tsx";
import { ThreadAiActions, ThreadAiResults, useThreadAi } from "./message/use-thread-ai.tsx";
import { MoveToFolderMenu } from "./move-to-folder-menu.tsx";
import { ReminderMenu } from "./reminder-menu.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Separator } from "./ui/separator.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

interface Props {
  thread: ThreadRow;
  messages: MessageRow[];
  view?: MailView;
  /** The list's unread-only filter, carried through when navigating back to it. */
  unread?: boolean;
  readOnly?: boolean;
  // Set when the thread is being viewed inside a custom folder, enabling the
  // "move back to mailbox" action in the move-to-folder menu.
  folderId?: string;
  /** Open the thread at this message (a search hit) rather than the newest. */
  focusMessageId?: string;
}

// Folded messages between the first and the last folded one collapse further
// into a single "N more messages" divider once there are at least this many.
const MIN_FOLD = 2;

export function MessageView({
  thread,
  messages,
  view = "inbox",
  unread,
  readOnly = false,
  folderId,
  focusMessageId,
}: Props) {
  const nav = useNavigate();
  const backSearch = listSearch(view, unread);
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
          search: backSearch,
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
          search: backSearch,
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
          search: backSearch,
        });
      },
    });
  }

  function markUnread() {
    const last = messages.findLast((m) => m.direction === "in" && !hasFlag(m.flags, Flag.TRASH));
    if (last) setMsg.mutate({ id: last.id, patch: { seen: false } });
  }

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

  // Which messages open expanded. Snapshotted when the thread opens (the view
  // is keyed per thread), so marking them read doesn't fold them away: a
  // linked message alone, else every unread one plus the newest. Mail that
  // arrives while the thread is open opens expanded too.
  const [initial] = useState(() => {
    const target = focusMessageId && visibleMessages.find((m) => m.id === focusMessageId);
    const open = target
      ? [target]
      : visibleMessages.filter(
          (m, i) =>
            i === visibleMessages.length - 1 ||
            (m.direction === "in" && !hasFlag(m.flags, Flag.SEEN)),
        );
    return {
      ids: new Set(visibleMessages.map((m) => m.id)),
      open: new Set(open.map((m) => m.id)),
      focus: open[0]?.id,
    };
  });
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [unfolded, setUnfolded] = useState(false);
  const isOpen = (m: MessageRow) =>
    overrides.get(m.id) ?? (initial.open.has(m.id) || !initial.ids.has(m.id));
  const setOpen = (id: string, open: boolean) =>
    setOverrides((prev) => new Map(prev).set(id, open));
  const allOpen = visibleMessages.every(isOpen);
  const setAll = (open: boolean) => {
    setUnfolded(true);
    setOverrides(new Map(visibleMessages.map((m) => [m.id, open])));
  };

  // Keep the first message and the one just before the first open message as
  // context; fold the run between them into one divider.
  const firstOpen = visibleMessages.findIndex(isOpen);
  const foldEnd = (firstOpen === -1 ? visibleMessages.length : firstOpen) - 1;
  const foldCount = unfolded ? 0 : Math.max(0, foldEnd - 1);
  const folded = foldCount >= MIN_FOLD;

  // Land on the first open message, with only folded rows above it, so the
  // position holds while bodies stream in below.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const card = container?.querySelector<HTMLElement>(
      `[data-message-id="${initial.focus ?? ""}"]`,
    );
    if (!container || !card || card === container.firstElementChild) return;
    const padTop = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
    container.scrollTop =
      card.getBoundingClientRect().top - container.getBoundingClientRect().top - padTop;
  }, [initial.focus]);

  // Side nav arrows: "up" goes to the oldest message, "down" to the newest.
  // Each shows only while there's room to travel that way.
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the cards when they fold or unfold
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
    for (const child of Array.from(container.children)) ro.observe(child);
    return () => {
      container.removeEventListener("scroll", update, opts);
      ro.disconnect();
    };
  }, [overrides, unfolded, visibleMessages.length]);
  const scrollTo = (top: number) => scrollRef.current?.scrollTo({ top, behavior: "smooth" });

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
          {visibleMessages.length > 1 && (
            <IconButton
              icon={allOpen ? ChevronsDownUp : ChevronsUpDown}
              label={allOpen ? "Collapse all" : "Expand all"}
              onClick={() => setAll(!allOpen)}
            />
          )}
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
                  search: backSearch,
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
            {visibleMessages.map((m, i) => {
              if (folded && i >= 1 && i < foldEnd) {
                if (i > 1) return null;
                return (
                  <div key="fold" className="flex items-center gap-3">
                    <Separator className="flex-1" />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setUnfolded(true)}
                      className="rounded-full"
                    >
                      {foldCount} more {foldCount === 1 ? "message" : "messages"}
                    </Button>
                    <Separator className="flex-1" />
                  </div>
                );
              }
              if (!isOpen(m))
                return <CollapsedMessage key={m.id} msg={m} onExpand={() => setOpen(m.id, true)} />;
              return (
                <MessageCard
                  key={m.id}
                  msg={m}
                  readOnly={readOnly}
                  highlight={m.id === focusMessageId}
                  onCollapse={visibleMessages.length > 1 ? () => setOpen(m.id, false) : undefined}
                  busy={setMsg.isPending || delMsg.isPending}
                  {...messageActions(m)}
                  onToggleStar={() =>
                    setMsg.mutate({
                      id: m.id,
                      patch: { starred: !hasFlag(m.flags, Flag.STARRED) },
                    })
                  }
                />
              );
            })}
          </div>
          {canUp && (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Oldest message"
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
