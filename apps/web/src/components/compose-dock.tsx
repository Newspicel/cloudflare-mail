import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { Paperclip, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api.ts";
import { type MessageRow, mailboxesQuery } from "@/lib/queries.ts";

marked.setOptions({ breaks: true, gfm: true });

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

interface UploadedAttachment {
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface ComposeState {
  open: boolean;
  replyToMessage: MessageRow | null;
  initialTo?: string;
}

const listeners = new Set<(s: ComposeState) => void>();
let state: ComposeState = { open: false, replyToMessage: null };

export function openCompose(partial: Partial<ComposeState> = {}): void {
  state = { ...state, open: true, replyToMessage: null, initialTo: undefined, ...partial };
  for (const l of listeners) l(state);
}
export function closeCompose(): void {
  state = { open: false, replyToMessage: null };
  for (const l of listeners) l(state);
}

export function ComposeDock() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  if (!s.open) return null;
  return <ComposePanel state={s} />;
}

function ComposePanel({ state: s }: { state: ComposeState }) {
  const qc = useQueryClient();
  const { data: mailboxes } = useQuery(mailboxesQuery);
  const sendable = (mailboxes?.mailboxes ?? []).filter((m) => (m.perms & 2) === 2);

  const [mailboxId, setMailboxId] = useState(s.replyToMessage?.mailboxId ?? sendable[0]?.id ?? "");
  const [to, setTo] = useState(s.replyToMessage?.fromAddr ?? s.initialTo ?? "");
  const [subject, setSubject] = useState(
    s.replyToMessage ? prefixSubject(s.replyToMessage.subject) : "",
  );
  const [text, setText] = useState("");
  const [markdown, setMarkdown] = useState(false);
  const [preview, setPreview] = useState(false);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewHtml = useMemo(() => {
    if (!markdown || !text.trim()) return "";
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [markdown, text]);

  const send = useMutation({
    mutationFn: async () => {
      const html = markdown && text.trim() ? previewHtml : undefined;
      return api<{ messageId: string; threadId: string }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          mailboxId,
          to: to
            .split(/[,;]\s*/)
            .filter(Boolean)
            .map((address) => ({ address })),
          subject,
          text,
          html,
          attachments: attachments.length
            ? attachments.map((a) => ({
                r2Key: a.r2Key,
                filename: a.filename,
                contentType: a.contentType,
              }))
            : undefined,
        }),
      });
    },
    onSuccess: () => {
      toast.success("Message sent");
      qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
      closeCompose();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  async function uploadFile(file: File): Promise<void> {
    if (file.size === 0) {
      toast.error(`${file.name}: empty file`);
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`${file.name}: exceeds 25 MB limit`);
      return;
    }
    setUploading((n) => n + 1);
    try {
      const up = await api<UploadedAttachment>("/api/attachments/upload", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-filename": encodeURIComponent(file.name),
        },
        body: await file.arrayBuffer(),
      });
      setAttachments((prev) => [...prev, { ...up, filename: file.name }]);
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
    } finally {
      setUploading((n) => n - 1);
    }
  }

  async function onPickFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    const picked = Array.from(fileList);
    const remaining = MAX_ATTACHMENTS - attachments.length;
    const toUpload = picked.slice(0, Math.max(0, remaining));
    if (picked.length > toUpload.length) {
      toast.error(`Only ${MAX_ATTACHMENTS} attachments per message`);
    }
    await Promise.all(toUpload.map(uploadFile));
  }

  return (
    <div className="fixed bottom-0 right-6 z-40 flex h-[520px] w-[520px] flex-col overflow-hidden rounded-t-xl border bg-card shadow-2xl shadow-black/20">
      <div className="flex items-center justify-between bg-foreground/95 px-4 py-2 text-background">
        <div className="text-sm font-medium">New message</div>
        <button
          type="button"
          onClick={closeCompose}
          className="rounded p-1 text-background/80 hover:bg-background/10 hover:text-background"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-4 py-3 text-sm">
        <label className="flex items-center gap-2 border-b py-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">From</span>
          <select
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
            className="flex-1 bg-transparent outline-none"
          >
            {sendable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 border-b py-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">To</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            className="flex-1 bg-transparent outline-none"
          />
        </label>
        <label className="flex items-center gap-2 border-b py-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1 bg-transparent outline-none"
          />
        </label>
        {markdown && preview ? (
          <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify
            dangerouslySetInnerHTML={{ __html: previewHtml }}
            className="prose prose-sm flex-1 max-w-none overflow-y-auto py-2 dark:prose-invert"
          />
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="flex-1 resize-none bg-transparent py-2 outline-none font-mono text-[13px]"
            placeholder={markdown ? "Write your message in markdown…" : "Write your message…"}
          />
        )}
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 border-t pt-2">
            {attachments.map((a) => (
              <li
                key={a.r2Key}
                className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="max-w-[16rem] truncate" title={a.filename}>
                  {a.filename}
                </span>
                <span className="text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.r2Key !== a.r2Key))}
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={`Remove ${a.filename}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => send.mutate()}
            disabled={send.isPending || uploading > 0 || !mailboxId || !to}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-105 disabled:opacity-50"
          >
            {send.isPending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => {
              setMarkdown((v) => {
                if (v) setPreview(false);
                return !v;
              });
            }}
            className={`rounded-md border px-2 py-1 text-xs ${markdown ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground"}`}
            aria-pressed={markdown}
            title="Toggle markdown"
          >
            MD
          </button>
          {markdown && (
            <button
              type="button"
              onClick={() => setPreview((v) => !v)}
              className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {preview ? "Edit" : "Preview"}
            </button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {uploading > 0
            ? `Uploading ${uploading}…`
            : sendable.length === 0
              ? "No sendable mailboxes"
              : null}
        </span>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function prefixSubject(s: string): string {
  if (/^re:/i.test(s.trim())) return s;
  return `Re: ${s}`;
}
