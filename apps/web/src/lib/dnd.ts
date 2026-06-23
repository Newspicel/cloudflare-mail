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

export function setThreadDrag(e: DragEvent, data: ThreadDragData): void {
  e.dataTransfer.setData(THREAD_MIME, JSON.stringify(data));
  e.dataTransfer.setData("text/plain", data.threadId);
  e.dataTransfer.effectAllowed = "move";
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
