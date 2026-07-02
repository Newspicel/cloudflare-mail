import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invalidateThreadChange, restoreSnapshot, snapshotMailboxThreads } from "./invalidate.ts";
import { keys } from "./query-keys.ts";

interface Config<V> {
  mailboxId: string;
  mutationFn: (vars: V) => Promise<unknown>;
  /**
   * Apply the optimistic change to the cached lists. When provided, the lists
   * are snapshotted first and restored automatically if the request fails;
   * omit it for fire-and-reconcile mutations.
   */
  optimistic?: (vars: V, qc: QueryClient) => void;
  /** Extra thread id to invalidate on settle (the open detail view). */
  threadId?: string;
  /** Side effect to run alongside the optimistic update, e.g. clear selection. */
  onApply?: (vars: V) => void;
  errorMessage?: string;
}

// The cancel → snapshot → mutate → restore-on-error → toast → settle dance,
// in one place so every thread mutation gets the same optimistic UX.
export function useThreadListMutation<V>({
  mailboxId,
  mutationFn,
  optimistic,
  threadId,
  onApply,
  errorMessage = "Failed",
}: Config<V>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: V) => {
      if (!optimistic) {
        onApply?.(vars);
        return {};
      }
      await qc.cancelQueries({ queryKey: keys.threadsRoot(mailboxId) });
      const snapshot = snapshotMailboxThreads(qc, mailboxId);
      optimistic(vars, qc);
      onApply?.(vars);
      return { snapshot };
    },
    onError: (e: unknown, _vars, ctx) => {
      if (ctx?.snapshot) restoreSnapshot(qc, ctx.snapshot);
      toast.error(e instanceof Error ? e.message : errorMessage);
    },
    // Every list mutation (trash/spam/read/delete) moves threads or flips unread
    // state, so mailbox badges and folder membership are always in scope.
    onSettled: () =>
      invalidateThreadChange(qc, { mailboxId, threadId, counts: true, folders: true }),
  });
}
