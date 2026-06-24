import type { ReminderDto } from "@cfmail/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api.ts";
import { keys } from "./query-keys.ts";

export type { ReminderDto as Reminder };

export const remindersQuery = queryOptions({
  queryKey: keys.reminders(),
  queryFn: () => api<{ reminders: ReminderDto[] }>("/api/reminders"),
  staleTime: 30_000,
});

export interface CreateReminderArgs {
  mailboxId: string;
  threadId: string;
  messageId?: string;
  remindAt: number;
  note?: string;
}

// Set a manual reminder on a thread. Resolves to the created reminder.
export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReminderArgs) =>
      api<{ reminder: ReminderDto }>("/api/reminders", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.reminders() });
      toast.success("Reminder set");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to set reminder"),
  });
}

// Reschedule / re-note / dismiss (status:"done") a reminder.
export function useUpdateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      remindAt?: number;
      note?: string | null;
      status?: "done";
    }) => {
      const { id, ...patch } = input;
      return api(`/api/reminders/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.reminders() }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
}

export function useDeleteReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/reminders/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.reminders() }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
}
