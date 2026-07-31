import type { AttachmentDto } from "@cfmail/shared/responses";
import { ChevronLeft, ChevronRight, Download, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";

// Types we render in-app. Everything else stays a download — the stored
// content-type comes from the sender's MIME headers, so only formats that are
// inert as documents (raster images) or handled by the browser's own isolated
// viewer (PDF) belong here. Never text/html or image/svg+xml.
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;
const PDF_TYPE = "application/pdf";

// `image/png; name="x.png"` — the parameters aren't part of the type.
function baseType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

export function isPreviewable(contentType: string): boolean {
  const t = baseType(contentType);
  return IMAGE_TYPES.test(t) || t === PDF_TYPE;
}

export function attachmentUrl(messageId: string, attId: string, download?: boolean): string {
  const base = `/api/messages/${messageId}/attachments/${attId}/raw`;
  return download ? `${base}?download` : base;
}

// PDFs are fetched and re-wrapped in a blob we type ourselves rather than framed
// from the API URL directly: the response carries a `sandbox` CSP (correct — it
// keeps hostile bytes inert on direct navigation) which stops Firefox's pdf.js
// from running, and a blob URL renders by the type we pin here, so bytes that
// lie about being a PDF still can't load as same-origin HTML.
function PdfView({ src, filename }: { src: string; filename: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    (async () => {
      try {
        const res = await fetch(src, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`${res.status}`);
        objectUrl = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: PDF_TYPE }));
        if (cancelled) return;
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
        <p>This PDF couldn’t be displayed here.</p>
        <a href={`${src}?download`} download={filename} className={buttonVariants()}>
          <Download />
          Download instead
        </a>
      </div>
    );
  }
  if (!url) return <Skeleton className="min-h-0 flex-1 rounded-lg" />;
  return (
    // The blob is typed application/pdf by us, so it can never load as HTML no
    // matter what the bytes are; a sandbox would only disable the browser's own
    // PDF viewer (Firefox's pdf.js needs allow-scripts).
    // oxlint-disable-next-line react/iframe-missing-sandbox
    <iframe src={url} title={filename} className="min-h-0 flex-1 rounded-lg border bg-white" />
  );
}

/**
 * Full-screen viewer for a message's image and PDF attachments, with paging
 * between the previewable ones. Open it by attachment id; `null` closes it.
 */
export function AttachmentPreview({
  messageId,
  attachments,
  openId,
  onOpenChange,
}: {
  messageId: string;
  attachments: AttachmentDto[];
  openId: string | null;
  onOpenChange: (id: string | null) => void;
}) {
  const items = attachments.filter((a) => isPreviewable(a.contentType));
  const index = items.findIndex((a) => a.id === openId);
  const current = index >= 0 ? items[index] : undefined;
  const go = (delta: number) => {
    const next = items[(index + delta + items.length) % items.length];
    if (next) onOpenChange(next.id);
  };

  // Arrow keys page through the set, matching the on-screen controls.
  useEffect(() => {
    if (!current || items.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog open={!!current} onOpenChange={(open) => !open && onOpenChange(null)}>
      {current && (
        <DialogContent
          showClose
          // Sized to the viewport rather than the default narrow dialog — a
          // document viewer is the content here, not a prompt.
          className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-5xl gap-3 p-4"
        >
          <header className="flex items-center gap-2 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-[13px]" title={current.filename}>
                {current.filename}
              </DialogTitle>
              {items.length > 1 && (
                <p className="text-[11px] text-muted-foreground">
                  {index + 1} of {items.length}
                </p>
              )}
            </div>
            {items.length > 1 && (
              <div className="flex items-center">
                <IconButton
                  label="Previous"
                  icon={ChevronLeft}
                  size="icon-sm"
                  onClick={() => go(-1)}
                />
                <IconButton label="Next" icon={ChevronRight} size="icon-sm" onClick={() => go(1)} />
              </div>
            )}
            <a
              href={attachmentUrl(messageId, current.id)}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              <ExternalLink />
              <span className="max-sm:sr-only">Open</span>
            </a>
            <a
              href={attachmentUrl(messageId, current.id, true)}
              download={current.filename}
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              <Download />
              <span className="max-sm:sr-only">Download</span>
            </a>
          </header>
          {baseType(current.contentType) === PDF_TYPE ? (
            <PdfView src={attachmentUrl(messageId, current.id)} filename={current.filename} />
          ) : (
            <div className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-lg bg-muted/40">
              <img
                src={attachmentUrl(messageId, current.id)}
                alt={current.filename}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
