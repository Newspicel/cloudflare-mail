import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api.ts";
import {
  invalidateThreadChange,
  removeThreadsFromFolder,
  removeThreadsFromLists,
} from "./invalidate.ts";

interface FileInput {
  folderId: string;
  threadIds: string[];
  mailboxId: string;
}

// File conversations into a custom folder (a "move"): optimistically drop them
// from the source mailbox lists; `invalidateThreadChange` reconciles the real
// counts and lists afterwards (also restoring on error).
export function useFileThread() {
  const qc = useQueryClient();
  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSettled invalidateThreadChange refreshes all affected lists/counts
  return useMutation({
    mutationFn: (v: FileInput) =>
      api(`/api/folders/${v.folderId}/threads`, {
        method: "POST",
        body: JSON.stringify({ threadIds: v.threadIds }),
      }),
    onMutate: (v) => {
      removeThreadsFromLists(qc, v.mailboxId, v.threadIds);
      removeThreadsFromLists(qc, "all", v.threadIds);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to move"),
    onSettled: (_d, _e, v) => invalidateThreadChange(qc, v.mailboxId),
  });
}

// Remove a conversation from a folder, returning it to its mailbox views.
export function useUnfileThread() {
  const qc = useQueryClient();
  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSettled invalidateThreadChange refreshes all affected lists/counts
  return useMutation({
    mutationFn: (v: { folderId: string; threadId: string; mailboxId: string }) =>
      api(`/api/folders/${v.folderId}/threads/${v.threadId}`, { method: "DELETE" }),
    onMutate: (v) => removeThreadsFromFolder(qc, v.folderId, [v.threadId]),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
    onSettled: (_d, _e, v) => invalidateThreadChange(qc, v.mailboxId, v.threadId),
  });
}
