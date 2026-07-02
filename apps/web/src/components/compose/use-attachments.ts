import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, rpc, unwrap } from "@/lib/api.ts";
import { downscaleImage } from "@/lib/resize-image.ts";
import { canStripMetadata, stripImageMetadata } from "@/lib/strip-image-metadata.ts";
import {
  CID_ATTR,
  draftBlobUrl,
  escapeAttr,
  isFileDrag,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type UploadedAttachment,
} from "./compose-utils.ts";

function onDragOver(e: React.DragEvent) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}

interface Options {
  initial: UploadedAttachment[];
  // Insert inline-image HTML into the message body (promoting a plain-text
  // body to rich when needed).
  embedInlineHtml: (imgHtml: string) => void;
}

// Attachment intake for the composer: uploads (picker/drag/paste), the
// attach-vs-inline image choice with metadata stripping and downscaling, and
// the drag-overlay state.
export function useAttachments({ initial, embedInlineHtml }: Options) {
  const [attachments, setAttachments] = useState<UploadedAttachment[]>(initial);
  const [uploading, setUploading] = useState(0);
  // Files being dragged over the composer (overlay) and the pending batch of
  // dropped/picked images awaiting an attach-vs-inline + strip-metadata choice.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [stripMeta, setStripMeta] = useState(true);
  const [placement, setPlacement] = useState<"attachment" | "inline">("inline");
  // Longest-edge cap applied to pending images before upload; 0 = keep original.
  const [resizeMax, setResizeMax] = useState(0);

  // Upload one file to draft storage and return the stored attachment (with any
  // inline/contentId flags merged in), or null on failure. Does not touch the
  // attachments list — callers decide how the result is surfaced.
  async function uploadBlob(
    file: File,
    extra?: { inline?: boolean; contentId?: string },
  ): Promise<UploadedAttachment | null> {
    if (file.size === 0) {
      toast.error(`${file.name}: empty file`);
      return null;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`${file.name}: exceeds 25 MB limit`);
      return null;
    }
    setUploading((n) => n + 1);
    try {
      // Raw-body upload: hc has no arg slot for opaque bodies, so the bytes ride
      // the request options; path + response stay statically typed.
      const up = await unwrap(
        rpc.attachments.upload.$post(undefined, {
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name),
          },
          init: { body: await file.arrayBuffer() },
        }),
      );
      return { ...up, filename: file.name, ...extra };
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.payload === "object" && err.payload && "message" in err.payload
            ? String((err.payload as { message: unknown }).message)
            : `upload failed (${err.status})`
          : err instanceof Error
            ? err.message
            : "upload failed";
      toast.error(`${file.name}: ${msg}`);
      return null;
    } finally {
      setUploading((n) => n - 1);
    }
  }

  // Upload a plain (non-inline) attachment and append it to the list.
  async function uploadAttachment(file: File): Promise<void> {
    const up = await uploadBlob(file);
    if (up) setAttachments((prev) => [...prev, up]);
  }

  // Entry point for both the file picker and drag-and-drop. Non-image files go
  // straight to attachments; images are held for the attach-vs-inline choice.
  async function handleIncomingFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    const remaining = MAX_ATTACHMENTS - attachments.length;
    const accepted = files.slice(0, Math.max(0, remaining));
    if (files.length > accepted.length) {
      toast.error(`Only ${MAX_ATTACHMENTS} attachments per message`);
    }
    const images = accepted.filter((f) => f.type.startsWith("image/"));
    const others = accepted.filter((f) => !f.type.startsWith("image/"));
    await Promise.all(others.map(uploadAttachment));
    if (images.length) setPendingImages((prev) => [...prev, ...images]);
  }

  // Resolve the pending images per the dialog choice: optionally strip metadata,
  // upload, then either attach or embed them inline in the (rich) body.
  async function commitPendingImages(): Promise<void> {
    const images = pendingImages;
    setPendingImages([]);
    if (!images.length) return;

    const prepared = await Promise.all(
      images.map(async (file) => {
        // Downscale first (this re-encodes and already drops metadata), then
        // strip — a no-op on a clean re-encode but needed for un-resized images.
        const sized = resizeMax ? await downscaleImage(file, resizeMax) : file;
        return stripMeta && canStripMetadata(sized.type) ? await stripImageMetadata(sized) : sized;
      }),
    );

    if (placement === "attachment") {
      const ups = await Promise.all(prepared.map((f) => uploadBlob(f)));
      const ok = ups.filter((u): u is UploadedAttachment => u !== null);
      if (ok.length) setAttachments((prev) => [...prev, ...ok]);
      return;
    }

    // Inline: upload each with a generated content id, collect the <img> tags,
    // then embed them in the HTML body (promoting from plain text if needed).
    const ups = await Promise.all(
      prepared.map(async (f) => {
        const contentId = `${crypto.randomUUID()}@cfmail`;
        const up = await uploadBlob(f, { inline: true, contentId });
        return up ? { up, contentId } : null;
      }),
    );
    const ok = ups.filter((x): x is { up: UploadedAttachment; contentId: string } => x !== null);
    if (!ok.length) return;

    setAttachments((prev) => [...prev, ...ok.map((x) => x.up)]);
    const imgHtml = ok
      .map(
        (x) =>
          `<img src="${draftBlobUrl(x.up.r2Key)}" ${CID_ATTR}="${x.contentId}" alt="${escapeAttr(
            x.up.filename,
          )}" style="max-width:100%;height:auto" />`,
      )
      .join("");
    embedInlineHtml(imgHtml);
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────
  function onDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }
  function onDrop(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void handleIncomingFiles(Array.from(e.dataTransfer.files));
  }
  const dragHandlers = { onDragEnter, onDragOver, onDragLeave, onDrop };

  // Paste an image straight from the clipboard (e.g. a screenshot). Only image
  // files are intercepted — pasting text/HTML falls through to the editor.
  function onPaste(e: React.ClipboardEvent) {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    void handleIncomingFiles(images);
  }

  return {
    attachments,
    setAttachments,
    uploading,
    dragActive,
    dragHandlers,
    onPaste,
    handleIncomingFiles,
    pendingImages,
    setPendingImages,
    stripMeta,
    setStripMeta,
    placement,
    setPlacement,
    resizeMax,
    setResizeMax,
    commitPendingImages,
  };
}
