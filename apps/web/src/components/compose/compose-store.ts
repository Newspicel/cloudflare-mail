import { parseUserPrefs } from "@cfmail/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { buildMailto, parseMailto } from "@/lib/mailto.ts";
import type { DraftRow, MessageRow, MeUser } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";

export interface ComposeState {
  open: boolean;
  replyToMessage: MessageRow | null;
  // Reply-all: also carry over the original To/Cc recipients (minus ourselves).
  replyAll?: boolean;
  forwardMessage: MessageRow | null;
  // Pre-filled recipients/subject (a mailto: link, or `/compose?to=`).
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
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
    const url = composeWindowUrl(partial);
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
    initialCc: undefined,
    initialBcc: undefined,
    initialSubject: undefined,
    initialBody: undefined,
    draft: null,
    ...partial,
    replyAll,
  };
  emit();
}

// The pre-filled fields, back in mailto form. "mailto:" means nothing was
// seeded — a plain blank composer.
function seedMailto(s: Partial<ComposeState>): string {
  return buildMailto({
    to: s.initialTo,
    cc: s.initialCc,
    bcc: s.initialBcc,
    subject: s.initialSubject,
    body: s.initialBody,
  });
}

// Seeded fields ride to the pop-out window as a mailto URL — the same shape
// `/compose` accepts from the OS protocol handler.
export function composeWindowUrl(s: Partial<ComposeState>): string {
  const mailto = seedMailto(s);
  return mailto === "mailto:" ? "/compose" : `/compose?mailto=${encodeURIComponent(mailto)}`;
}

// Remount key for a seeded (mailto) compose: clicking a second mailto link
// while the dock is already open has to re-initialize the form, but a plain
// "new message" must not wipe what's already typed.
export function composeSeedKey(s: ComposeState): string {
  const mailto = seedMailto(s);
  return mailto === "mailto:" ? "new" : mailto;
}

// Open the composer for a `mailto:` URL. Returns false if it isn't one.
export function openMailto(href: string): boolean {
  const f = parseMailto(href);
  if (!f) return false;
  const seed: Partial<ComposeState> = {
    initialTo: f.to,
    initialCc: f.cc,
    initialBcc: f.bcc,
    initialSubject: f.subject,
    initialBody: f.body,
  };
  // No subscriber means no <ComposeDock> is mounted — we're in the standalone
  // /compose window, where a store update would go nowhere. Hand the message to
  // a second composer window instead of swallowing the click.
  if (listeners.size === 0) {
    window.open(composeWindowUrl(seed), "_blank", "popup,width=720,height=860");
    return true;
  }
  openCompose(seed);
  return true;
}

export function closeCompose(): void {
  state = { open: false, replyToMessage: null, forwardMessage: null };
  emit();
}
