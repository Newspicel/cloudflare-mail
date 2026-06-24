import type { MessageBodyDto } from "@cfmail/shared/responses";
import { useMutation } from "@tanstack/react-query";
import {
  ArchiveRestore,
  Ban,
  Code2,
  Copy,
  Download,
  EllipsisVertical,
  FileText,
  Mail,
  Printer,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import type { MessageRow } from "@/lib/queries.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { type DateTimeFmt, formatDateTime } from "@/lib/time.ts";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { IconButton } from "./ui/icon-button.tsx";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Renders the message body in a hidden same-origin iframe and prints it. Using
// `srcdoc` + the load event lets proxied (same-origin) images settle before the
// print dialog opens; the frame is torn down afterwards.
function printMessage(msg: MessageRow, body: MessageBodyDto | undefined, fmt: DateTimeFmt) {
  const html = body?.html ? sanitizeEmailHtml(body.html) : null;
  const content = html ?? `<pre>${escapeHtml(body?.text ?? msg.snippet ?? "")}</pre>`;
  const when = formatDateTime(new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt), fmt);
  const head = `
    <div style="font-size:12px;color:#444;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">
      <div><strong>${escapeHtml(msg.subject || "(no subject)")}</strong></div>
      <div>From: ${escapeHtml(msg.fromName ?? msg.fromAddr)} &lt;${escapeHtml(msg.fromAddr)}&gt;</div>
      <div>To: ${escapeHtml(msg.toAddrs.map((a) => a.address).join(", "))}</div>
      <div>Date: ${escapeHtml(when)}</div>
    </div>`;
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(msg.subject || "Email")}</title>` +
    `<style>body{font:13px/1.5 system-ui,sans-serif;color:#111;margin:24px}` +
    `img,table{max-width:100%}pre{white-space:pre-wrap;font:inherit}` +
    `a{color:#2563eb}</style></head><body>${head}${content}</body></html>`;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.addEventListener(
    "load",
    () => {
      const win = frame.contentWindow;
      if (!win) return;
      win.focus();
      win.print();
      setTimeout(() => frame.remove(), 1000);
    },
    { once: true },
  );
  frame.srcdoc = doc;
  document.body.appendChild(frame);
}

type Source = { title: string; content: string };

export function MessageMenu({
  msg,
  body,
  onTrash,
  onRestore,
  onDelete,
  busy,
}: {
  msg: MessageRow;
  body: MessageBodyDto | undefined;
  // Per-message actions, supplied by the thread view depending on the message's
  // state. Soft-delete into Trash, restore from it, or permanently delete.
  onTrash?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  busy?: boolean;
}) {
  const fmt = useDateTimeFmt();
  const [source, setSource] = useState<Source | null>(null);
  const [loadingRaw, setLoadingRaw] = useState(false);

  const requestBlock = useMutation({
    mutationFn: () =>
      api<{ status: string }>(`/api/messages/${msg.id}/block-request`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (res) => {
      toast.success(
        res.status === "already-blocked"
          ? "Sender is already blocked"
          : res.status === "pending"
            ? "You already requested this block"
            : "Block request sent to an admin",
      );
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  async function showRaw() {
    setLoadingRaw(true);
    try {
      const res = await fetch(`/api/messages/${msg.id}/raw`, { credentials: "include" });
      if (!res.ok) throw new Error("Could not load raw email");
      setSource({ title: "Raw email (.eml)", content: await res.text() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoadingRaw(false);
    }
  }

  function exportEml() {
    const a = document.createElement("a");
    a.href = `/api/messages/${msg.id}/raw?download=1`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<IconButton icon={EllipsisVertical} label="More" disabled={loadingRaw} />}
        />
        <DropdownMenuContent>
          <DropdownMenuItem onClick={showRaw}>
            <Mail /> View raw email
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!body?.text}
            onClick={() =>
              body?.text && setSource({ title: "Plain-text body", content: body.text })
            }
          >
            <FileText /> View plain text
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!body?.html}
            onClick={() => body?.html && setSource({ title: "HTML source", content: body.html })}
          >
            <Code2 /> View HTML source
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => printMessage(msg, body, fmt)}>
            <Printer /> Print
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportEml}>
            <Download /> Export (.eml)
          </DropdownMenuItem>
          {(msg.direction === "in" || onTrash || onRestore || onDelete) && (
            <DropdownMenuSeparator />
          )}
          {msg.direction === "in" && (
            <DropdownMenuItem
              variant="destructive"
              disabled={requestBlock.isPending}
              onClick={() => requestBlock.mutate()}
            >
              <Ban /> Request block
            </DropdownMenuItem>
          )}
          {onRestore && (
            <DropdownMenuItem disabled={busy} onClick={onRestore}>
              <ArchiveRestore /> Restore message
            </DropdownMenuItem>
          )}
          {onTrash && (
            <DropdownMenuItem variant="destructive" disabled={busy} onClick={onTrash}>
              <Trash2 /> Delete message
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem variant="destructive" disabled={busy} onClick={onDelete}>
              <Trash2 /> Delete permanently
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={source !== null} onOpenChange={(o) => !o && setSource(null)}>
        {source && (
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{source.title}</DialogTitle>
              <DialogDescription>{msg.subject || "(no subject)"}</DialogDescription>
            </DialogHeader>
            <pre className="max-h-[65vh] overflow-auto rounded-lg border bg-muted/40 p-3 text-[11px] leading-relaxed">
              {source.content}
            </pre>
            <div className="flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(source.content)
                    .then(() => toast.success("Copied"));
                }}
              >
                <Copy /> Copy
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
