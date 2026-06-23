import type { DragEvent } from "react";

// Native HTML5 drag-and-drop payload for moving a conversation into a custom
// folder. We keep the data on a private MIME type so unrelated drops are
// ignored, and mirror the thread id onto text/plain for good measure.
export const THREAD_MIME = "application/x-cfmail-thread";

export interface ThreadDragData {
  threadId: string;
  mailboxId: string;
  /** Folder the drag started from, when dragging a row out of a folder view. */
  fromFolderId?: string;
}

const DRAG_GHOST_ATTR = "data-cfmail-drag-ghost";

export function setThreadDrag(e: DragEvent, data: ThreadDragData): void {
  e.dataTransfer.setData(THREAD_MIME, JSON.stringify(data));
  e.dataTransfer.setData("text/plain", data.threadId);
  e.dataTransfer.effectAllowed = "move";

  // Don't hand the live row to setDragImage: it sits inside a scrolling /
  // composited ancestor, and Chromium then snapshots that whole layer (the
  // entire window) instead of the row. Snapshot a detached clone parented
  // straight to <body> so the ghost is exactly the row. Cleaned up on dragend.
  const row = e.currentTarget as HTMLElement;
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.setAttribute(DRAG_GHOST_ATTR, "");
  Object.assign(ghost.style, {
    position: "fixed",
    top: "-10000px",
    left: "0",
    width: `${rect.width}px`,
    margin: "0",
    listStyle: "none",
    pointerEvents: "none",
    background: "var(--color-card)",
  });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top);
}

/** Remove any leftover drag-image clone. Wire to the row's onDragEnd. */
export function clearThreadDragGhost(): void {
  for (const n of document.querySelectorAll(`[${DRAG_GHOST_ATTR}]`)) n.remove();
}

export function readThreadDrag(e: DragEvent): ThreadDragData | null {
  const raw = e.dataTransfer.getData(THREAD_MIME);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as ThreadDragData;
    if (typeof d?.threadId === "string" && typeof d?.mailboxId === "string") return d;
  } catch {
    /* ignore malformed payloads */
  }
  return null;
}

export function isThreadDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(THREAD_MIME);
}
