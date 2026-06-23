import type { HubEvent } from "@cfmail/shared/events";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { bumpMailboxUnread, bumpThreadToTop, invalidateThreadChange } from "./invalidate.ts";
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
          break;
        }
        case "mailbox_expired": {
          qc.invalidateQueries({ queryKey: keys.mailboxes() });
          break;
        }
        case "ping":
          break;
      }
    } catch {
      /* ignore malformed events */
    }
  };

  for (const t of ["new_message", "message_sent", "mailbox_expired", "ping"]) {
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
