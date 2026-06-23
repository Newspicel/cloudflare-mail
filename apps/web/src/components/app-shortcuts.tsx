import { Flag, hasFlag } from "@cfmail/shared/flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { type MessageRow, parseMailView, threadQuery, threadsQuery } from "@/lib/queries.ts";
import { useKeyboardShortcuts } from "@/lib/shortcuts.ts";
import { openCompose } from "./compose-dock.tsx";
import { ShortcutsDialog } from "./shortcuts-dialog.tsx";

export function AppShortcuts() {
  const params = useParams({ strict: false }) as { mailboxId?: string; threadId?: string };
  const { mailboxId, threadId } = params;
  const search = useSearch({ strict: false }) as { view?: unknown };
  const view = parseMailView(search.view);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [helpOpen, setHelpOpen] = useState(false);

  const threadsQ = useQuery({
    ...threadsQuery(mailboxId ?? "", view),
    enabled: Boolean(mailboxId),
  });

  const setThreadState = useMutation({
    mutationFn: (input: { id: string; patch: { trashed?: boolean; spam?: boolean } }) =>
      api(`/api/threads/${input.id}`, { method: "PATCH", body: JSON.stringify(input.patch) }),
    onSuccess: () => {
      if (mailboxId) qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
      if (threadId) qc.invalidateQueries({ queryKey: ["thread", threadId] });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const moveThread = useCallback(
    (patch: { trashed?: boolean; spam?: boolean }, label: string, undo: typeof patch) => {
      if (!threadId) return;
      const id = threadId;
      setThreadState.mutate(
        { id, patch },
        {
          onSuccess: () => {
            toast.success(label, {
              action: { label: "Undo", onClick: () => setThreadState.mutate({ id, patch: undo }) },
            });
          },
        },
      );
      if (mailboxId) nav({ to: "/app/m/$mailboxId", params: { mailboxId }, search: { view } });
    },
    [threadId, mailboxId, view, nav, setThreadState],
  );

  const navigateThread = useCallback(
    (delta: number) => {
      if (!mailboxId) return;
      const threads = threadsQ.data?.threads ?? [];
      if (threads.length === 0) return;
      const idx = threadId ? threads.findIndex((t) => t.id === threadId) : -1;
      const nextIdx =
        idx === -1
          ? delta > 0
            ? 0
            : threads.length - 1
          : Math.min(Math.max(idx + delta, 0), threads.length - 1);
      const target = threads[nextIdx];
      if (!target) return;
      nav({
        to: "/app/m/$mailboxId/t/$threadId",
        params: { mailboxId, threadId: target.id },
        search: { view },
      });
    },
    [mailboxId, threadId, view, threadsQ.data, nav],
  );

  const withLastMessage = useCallback(
    async (fn: (msg: MessageRow) => void) => {
      if (!threadId) return;
      const data = await qc.ensureQueryData(threadQuery(threadId));
      const last = data?.messages?.at(-1);
      if (last) fn(last);
    },
    [qc, threadId],
  );

  useKeyboardShortcuts((e) => {
    if (e.key === "?") {
      e.preventDefault();
      setHelpOpen((v) => !v);
      return;
    }
    if (e.key === "/") {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search mail"]');
      if (input) {
        e.preventDefault();
        input.focus();
      }
      return;
    }
    if (e.key === "j") {
      e.preventDefault();
      navigateThread(1);
      return;
    }
    if (e.key === "k") {
      e.preventDefault();
      navigateThread(-1);
      return;
    }
    if (e.key === "c") {
      e.preventDefault();
      openCompose();
      return;
    }
    if (!threadId) return;
    if (e.key === "r") {
      e.preventDefault();
      void withLastMessage((last) => openCompose({ replyToMessage: last }));
      return;
    }
    if (e.key === "f") {
      e.preventDefault();
      void withLastMessage((last) => openCompose({ forwardMessage: last }));
      return;
    }
    if (e.key === "s") {
      e.preventDefault();
      void withLastMessage((last) =>
        api(`/api/messages/${last.id}`, {
          method: "PATCH",
          body: JSON.stringify({ starred: !hasFlag(last.flags, Flag.STARRED) }),
        }).then(() => {
          qc.invalidateQueries({ queryKey: ["thread", threadId] });
          if (mailboxId) qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
        }),
      );
      return;
    }
    if (e.key === "u") {
      e.preventDefault();
      void withLastMessage((last) =>
        api(`/api/messages/${last.id}`, {
          method: "PATCH",
          body: JSON.stringify({ seen: false }),
        }).then(() => {
          if (mailboxId) qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
          qc.invalidateQueries({ queryKey: ["mailboxes"] });
        }),
      );
      return;
    }
    if (e.key === "!" && view !== "spam") {
      e.preventDefault();
      moveThread({ spam: true }, "Marked as spam", { spam: false });
      return;
    }
    if (e.key === "!" && view === "spam") {
      e.preventDefault();
      moveThread({ spam: false }, "Moved to Inbox", { spam: true });
      return;
    }
    if (e.key === "#") {
      e.preventDefault();
      moveThread({ trashed: true }, "Moved to Trash", { trashed: false });
      return;
    }
  });

  return <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />;
}
