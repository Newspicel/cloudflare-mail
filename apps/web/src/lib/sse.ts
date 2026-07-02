import type { HubEvent } from "@cfmail/shared/events";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ApiError, rpc, unwrap } from "./api.ts";
import {
  bumpMailboxUnread,
  bumpThreadToTop,
  createThreadChangeCoalescer,
  patchThreadsInLists,
} from "./invalidate.ts";
import { dismissThreadNotification } from "./push.ts";
import { type MailboxSummary, mailboxesQuery } from "./queries.ts";
import { keys } from "./query-keys.ts";

type Navigate = (to: { mailboxId: string; threadId: string }) => void;

// ── Connection status ────────────────────────────────────────────────────────
// Tiny module-level store so the UI can surface "reconnecting" without owning
// the EventSource. EventSource reconnects on its own; this only reports it.

export type StreamStatus = "connected" | "reconnecting";

let streamStatus: StreamStatus = "connected";
const statusListeners = new Set<() => void>();

function setStreamStatus(next: StreamStatus): void {
  if (streamStatus === next) return;
  streamStatus = next;
  for (const l of statusListeners) l();
}

function subscribeStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStatus, () => streamStatus);
}

// EventSource can't see the HTTP status behind a failure, so on error we probe
// the session with a cheap authenticated request. A 401 means the session is
// gone — bounce to login (same destination the route guard uses); anything else
// is a transient outage and the stream keeps retrying. Throttled because the
// browser fires onerror on every failed reconnect attempt.
const PROBE_MIN_INTERVAL_MS = 10_000;
let lastProbeAt = 0;

async function probeSession(): Promise<void> {
  const now = Date.now();
  if (now - lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
  lastProbeAt = now;
  try {
    await unwrap(rpc.me.$get());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) window.location.assign("/login");
  }
}

const EVENT_TYPES = [
  "new_message",
  "message_sent",
  "thread_updated",
  "thread_read",
  "mailbox_expired",
  "scheduled_send_failed",
  "reminder_fired",
  "ping",
] as const;

export function connectStream(qc: QueryClient, navigate?: Navigate): () => void {
  const coalescer = createThreadChangeCoalescer(qc);
  let es: EventSource | null = null;
  let closed = false;

  const onEvent = (raw: MessageEvent<string>) => {
    let evt: HubEvent;
    try {
      evt = JSON.parse(raw.data) as HubEvent;
    } catch (err) {
      console.warn("Malformed SSE event", raw.data, err);
      return;
    }
    switch (evt.type) {
      case "new_message": {
        const nowIso = new Date().toISOString();
        bumpThreadToTop(qc, evt.mailboxId, evt.threadId, nowIso, true);
        bumpMailboxUnread(qc, evt.mailboxId, 1);
        // New mail changes unread badges and can be auto-filed by rules.
        coalescer.push({
          mailboxId: evt.mailboxId,
          threadId: evt.threadId,
          counts: true,
          folders: true,
        });
        notifyNewMessage(qc, evt.mailboxId, evt.threadId, navigate);
        break;
      }
      case "message_sent": {
        const nowIso = new Date().toISOString();
        bumpThreadToTop(qc, evt.mailboxId, evt.threadId, nowIso, false);
        // A sent message bumps msgCount/lastMsgAt (also visible in folder
        // lists) but never touches unread badges.
        coalescer.push({ mailboxId: evt.mailboxId, threadId: evt.threadId, folders: true });
        // A scheduled send the cron just dispatched deletes its draft — drop it
        // from the Drafts list too (harmless for ordinary sends, which already
        // clear their own draft client-side).
        qc.invalidateQueries({ queryKey: keys.drafts(evt.mailboxId) });
        qc.invalidateQueries({ queryKey: keys.drafts("all") });
        break;
      }
      case "thread_updated": {
        // In-place metadata change (e.g. AI summary landed) — refresh the list
        // and the open thread; no counts or folder membership involved.
        coalescer.push({ mailboxId: evt.mailboxId, threadId: evt.threadId });
        break;
      }
      case "thread_read": {
        // A peer device changed the thread's read state. Mirror its unread
        // badge locally and reconcile counts; on read, dismiss its push.
        patchThreadsInLists(qc, evt.mailboxId, [evt.threadId], {
          unreadCount: evt.read ? 0 : 1,
        });
        coalescer.push({
          mailboxId: evt.mailboxId,
          threadId: evt.threadId,
          counts: true,
          folders: true,
        });
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
  };

  function open(): void {
    if (closed) return;
    es = new EventSource("/api/stream", { withCredentials: true });
    es.addEventListener("open", () => setStreamStatus("connected"));
    es.addEventListener("error", () => {
      setStreamStatus("reconnecting");
      void probeSession();
    });
    for (const t of EVENT_TYPES) es.addEventListener(t, onEvent);
  }

  // EventSource retries CONNECTING failures itself but gives up for good once
  // CLOSED; regaining the network or returning to the tab is the moment to
  // force a fresh connection either way.
  const onWake = () => {
    if (closed || document.visibilityState === "hidden") return;
    if (es && es.readyState !== EventSource.OPEN) {
      es.close();
      open();
    }
  };
  window.addEventListener("online", onWake);
  document.addEventListener("visibilitychange", onWake);

  open();

  return () => {
    closed = true;
    window.removeEventListener("online", onWake);
    document.removeEventListener("visibilitychange", onWake);
    es?.close();
    coalescer.dispose();
    setStreamStatus("connected");
  };
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
