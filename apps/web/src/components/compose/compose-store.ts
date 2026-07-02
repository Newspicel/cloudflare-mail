import { parseUserPrefs } from "@cfmail/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { DraftRow, MessageRow, MeUser } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";

export interface ComposeState {
  open: boolean;
  replyToMessage: MessageRow | null;
  // Reply-all: also carry over the original To/Cc recipients (minus ourselves).
  replyAll?: boolean;
  forwardMessage: MessageRow | null;
  initialTo?: string;
  // Pre-fills the body (plain text). Used by AI smart-reply to seed a draft.
  initialBody?: string;
  // When set, the composer reopens an existing server-persisted draft.
  draft?: DraftRow | null;
}

let state: ComposeState = {
  open: false,
  replyToMessage: null,
  forwardMessage: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useComposeState(): ComposeState {
  return useSyncExternalStore(subscribe, () => state);
}

// openCompose runs outside React (menus, shortcuts), so compose-related prefs
// are read straight from the Query cache via the client the always-mounted
// <ComposeDock> registers — no hand-mirrored copy to keep in sync.
let queryClient: QueryClient | null = null;

export function registerComposeQueryClient(qc: QueryClient): void {
  queryClient = qc;
}

function composePrefs(): { composeInNewWindow?: boolean; replyAllDefault?: boolean } {
  const me = queryClient?.getQueryData<{ user: MeUser | null }>(keys.me());
  return parseUserPrefs(me?.user?.preferences);
}

export function openCompose(partial: Partial<ComposeState> = {}): void {
  const prefs = composePrefs();
  const fresh = !partial.replyToMessage && !partial.forwardMessage && !partial.draft;
  // Pop a brand-new message out to its own window when preferred. Safe from the
  // popup blocker because openCompose runs inside the originating click/keydown.
  if (fresh && prefs.composeInNewWindow) {
    const url = partial.initialTo
      ? `/compose?to=${encodeURIComponent(partial.initialTo)}`
      : "/compose";
    if (window.open(url, "_blank", "popup,width=720,height=860")) return;
    // Popup blocked — fall back to the in-app dock.
  }
  // A reply defaults to reply-all when the user opted in (unless the caller,
  // e.g. the explicit "Reply all" button, set it).
  const replyAll = partial.replyToMessage
    ? (partial.replyAll ?? prefs.replyAllDefault ?? false)
    : false;
  state = {
    open: true,
    replyToMessage: null,
    forwardMessage: null,
    initialTo: undefined,
    draft: null,
    ...partial,
    replyAll,
  };
  emit();
}

export function closeCompose(): void {
  state = { open: false, replyToMessage: null, forwardMessage: null };
  emit();
}
