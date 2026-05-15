import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { threadQuery, threadsQuery } from "@/lib/queries.ts";
import { useKeyboardShortcuts } from "@/lib/shortcuts.ts";
import { openCompose } from "./compose-dock.tsx";

export function AppShortcuts() {
  const params = useParams({ strict: false }) as { mailboxId?: string; threadId?: string };
  const { mailboxId, threadId } = params;
  const nav = useNavigate();
  const qc = useQueryClient();

  const threadsQ = useQuery({
    ...threadsQuery(mailboxId ?? ""),
    enabled: Boolean(mailboxId),
  });

  const setThreadState = useMutation({
    mutationFn: (input: { id: string; patch: { archived?: boolean; trashed?: boolean } }) =>
      api(`/api/threads/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input.patch),
      }),
    onSuccess: () => {
      if (mailboxId) qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
      if (threadId) qc.invalidateQueries({ queryKey: ["thread", threadId] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const navigateThread = useCallback(
    (delta: number) => {
      if (!mailboxId) return;
      const threads = threadsQ.data?.threads ?? [];
      if (threads.length === 0) return;
      const idx = threadId ? threads.findIndex((t) => t.id === threadId) : -1;
      let nextIdx: number;
      if (idx === -1) {
        nextIdx = delta > 0 ? 0 : threads.length - 1;
      } else {
        nextIdx = Math.min(Math.max(idx + delta, 0), threads.length - 1);
      }
      const target = threads[nextIdx];
      if (!target) return;
      nav({
        to: "/app/m/$mailboxId/t/$threadId",
        params: { mailboxId, threadId: target.id },
      });
    },
    [mailboxId, threadId, threadsQ.data, nav],
  );

  const replyToCurrent = useCallback(async () => {
    if (!threadId) return;
    const data = await qc.ensureQueryData(threadQuery(threadId));
    const last = data?.messages?.at(-1);
    if (last) openCompose({ replyToMessage: last });
  }, [qc, threadId]);

  useKeyboardShortcuts((e) => {
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
    if (e.key === "r" && threadId) {
      e.preventDefault();
      void replyToCurrent();
      return;
    }
    if (e.key === "e" && threadId) {
      e.preventDefault();
      setThreadState.mutate({ id: threadId, patch: { archived: true } });
      if (mailboxId) {
        nav({ to: "/app/m/$mailboxId", params: { mailboxId } });
      }
      return;
    }
    if (e.key === "#" && threadId) {
      e.preventDefault();
      setThreadState.mutate({ id: threadId, patch: { trashed: true } });
      if (mailboxId) {
        nav({ to: "/app/m/$mailboxId", params: { mailboxId } });
      }
      return;
    }
  });

  return null;
}
