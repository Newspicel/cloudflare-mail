import type { HubEvent } from "@cfmail/shared/events";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bumpMailboxUnread,
  bumpThreadToTop,
  invalidateThreadChange,
  patchThreadsInLists,
} from "./invalidate.ts";
import { dismissThreadNotification } from "./push.ts";
import { type MailboxSummary, mailboxesQuery } from "./queries.ts";
import { keys } from "./query-keys.ts";

type Navigate = (to: { mailboxId: string; threadId: string }) => void;

export function connectStream(qc: QueryClient, navigate?: Navigate): () => void {
  const es = new EventSource("/api/stream", { withCredentials: true });

  const onEvent = (raw: MessageEvent<string>) => {
    try {
      const evt = JSON.parse(raw.data) as HubEvent;
      switch (evt.type) {
        case "new_message": {
          const nowIso = new Date().toISOString();
          bumpThreadToTop(qc, evt.mailboxId, evt.threadId, nowIso, true);
          bumpMailboxUnread(qc, evt.mailboxId, 1);
          invalidateThreadChange(qc, evt.mailboxId, evt.threadId);
          notifyNewMessage(qc, evt.mailboxId, evt.threadId, navigate);
          break;
        }
        case "message_sent": {
          const nowIso = new Date().toISOString();
          bumpThreadToTop(qc, evt.mailboxId, evt.threadId, nowIso, false);
          invalidateThreadChange(qc, evt.mailboxId, evt.threadId);
          // A scheduled send the cron just dispatched deletes its draft — drop it
          // from the Drafts list too (harmless for ordinary sends, which already
          // clear their own draft client-side).
          qc.invalidateQueries({ queryKey: keys.drafts(evt.mailboxId) });
          qc.invalidateQueries({ queryKey: keys.drafts("all") });
          break;
        }
        case "thread_updated": {
          // In-place metadata change (e.g. AI summary landed) — refresh the list
          // and the open thread without bumping it to the top.
          invalidateThreadChange(qc, evt.mailboxId, evt.threadId);
          break;
        }
        case "thread_read": {
          // A peer device changed the thread's read state. Mirror its unread
          // badge locally and reconcile counts; on read, dismiss its push.
          patchThreadsInLists(qc, evt.mailboxId, [evt.threadId], {
            unreadCount: evt.read ? 0 : 1,
          });
          invalidateThreadChange(qc, evt.mailboxId, evt.threadId);
          if (evt.read) dismissThreadNotification(evt.threadId);
          break;
        }
        case "mailbox_expired": {
          qc.invalidateQueries({ queryKey: keys.mailboxes() });
          break;
        }
        case "scheduled_send_failed": {
          // The send was reverted to a draft — refresh the drafts list and warn.
          qc.invalidateQueries({ queryKey: keys.drafts(evt.mailboxId) });
          qc.invalidateQueries({ queryKey: keys.drafts("all") });
          qc.invalidateQueries({ queryKey: keys.folderCounts(evt.mailboxId) });
          toast.error(`Scheduled send failed: ${evt.error}`);
          break;
        }
        case "reminder_fired": {
          // A reminder's time arrived (on any device). Refresh the bell and
          // surface a toast that jumps to the thread.
          qc.invalidateQueries({ queryKey: keys.reminders() });
          toast(evt.subject || "Reminder", {
            description: evt.note || undefined,
            action: navigate
              ? {
                  label: "Open",
                  onClick: () => navigate({ mailboxId: evt.mailboxId, threadId: evt.threadId }),
                }
              : undefined,
          });
          break;
        }
        case "ping":
          break;
      }
    } catch {
      /* ignore malformed events */
    }
  };

  for (const t of [
    "new_message",
    "message_sent",
    "thread_updated",
    "thread_read",
    "mailbox_expired",
    "scheduled_send_failed",
    "reminder_fired",
    "ping",
  ]) {
    es.addEventListener(t, onEvent);
  }
  return () => es.close();
}

function notifyNewMessage(
  qc: QueryClient,
  mailboxId: string,
  threadId: string,
  navigate?: Navigate,
): void {
  // Don't interrupt if the user is already looking at this mailbox.
  if (window.location.pathname.includes(`/m/${mailboxId}`)) return;
  const cached = qc.getQueryData<{ mailboxes: MailboxSummary[] }>(mailboxesQuery.queryKey);
  const mailbox = cached?.mailboxes.find((m) => m.id === mailboxId);
  const where = mailbox ? (mailbox.displayName ?? mailbox.address) : "a mailbox";
  toast(`New message in ${where}`, {
    action: navigate
      ? { label: "Open", onClick: () => navigate({ mailboxId, threadId }) }
      : undefined,
  });
}
