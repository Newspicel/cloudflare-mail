import type { HubEvent } from "@cfmail/shared/events";
import type { QueryClient } from "@tanstack/react-query";

export function connectStream(qc: QueryClient): () => void {
  const es = new EventSource("/api/stream", { withCredentials: true });

  const onEvent = (raw: MessageEvent<string>) => {
    try {
      const evt = JSON.parse(raw.data) as HubEvent;
      switch (evt.type) {
        case "new_message":
        case "message_sent": {
          qc.invalidateQueries({ queryKey: ["threads", evt.mailboxId] });
          qc.invalidateQueries({ queryKey: ["thread", evt.threadId] });
          break;
        }
        case "mailbox_expired": {
          qc.invalidateQueries({ queryKey: ["mailboxes"] });
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
