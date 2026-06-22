import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { Paperclip, Trash2, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { type MessageRow, mailboxesQuery } from "@/lib/queries.ts";

marked.setOptions({ breaks: true, gfm: true });

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const DRAFT_PREFIX = "cfmail:draft:";

interface UploadedAttachment {
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface ComposeState {
  open: boolean;
  replyToMessage: MessageRow | null;
  forwardMessage: MessageRow | null;
  initialTo?: string;
}

interface DraftData {
  mailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  markdown: boolean;
}

const listeners = new Set<(s: ComposeState) => void>();
let state: ComposeState = { open: false, replyToMessage: null, forwardMessage: null };

export function openCompose(partial: Partial<ComposeState> = {}): void {
  state = {
    open: true,
    replyToMessage: null,
    forwardMessage: null,
    initialTo: undefined,
    ...partial,
  };
  for (const l of listeners) l(state);
}
export function closeCompose(): void {
  state = { open: false, replyToMessage: null, forwardMessage: null };
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

function draftKey(s: ComposeState): string {
  return `${DRAFT_PREFIX}${s.replyToMessage?.id ?? s.forwardMessage?.id ?? "new"}`;
}

function loadDraft(key: string): DraftData | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as DraftData) : null;
  } catch {
    return null;
  }
}

function ComposePanel({ state: s }: { state: ComposeState }) {
  const qc = useQueryClient();
  const { data: mailboxes } = useQuery(mailboxesQuery);
  const sendable = (mailboxes?.mailboxes ?? []).filter((m) => (m.perms & 2) === 2);
  const key = draftKey(s);
  const saved = useMemo(() => loadDraft(key), [key]);

  const fwd = s.forwardMessage;
  const [mailboxId, setMailboxId] = useState(
    saved?.mailboxId ?? s.replyToMessage?.mailboxId ?? fwd?.mailboxId ?? sendable[0]?.id ?? "",
  );
  const [to, setTo] = useState(saved?.to ?? s.replyToMessage?.fromAddr ?? s.initialTo ?? "");
  const [cc, setCc] = useState(saved?.cc ?? "");
  const [bcc, setBcc] = useState(saved?.bcc ?? "");
  const [showCc, setShowCc] = useState(Boolean(saved?.cc || saved?.bcc));
  const [subject, setSubject] = useState(
    saved?.subject ??
      (s.replyToMessage
        ? prefixSubject(s.replyToMessage.subject, "Re")
        : fwd
          ? prefixSubject(fwd.subject, "Fwd")
          : ""),
  );
  const [text, setText] = useState(saved?.text ?? (fwd ? quoteForward(fwd) : ""));
  const [markdown, setMarkdown] = useState(saved?.markdown ?? false);
  const [preview, setPreview] = useState(false);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [savedHint, setSavedHint] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debounced draft persistence.
  useEffect(() => {
    const isEmpty = !to && !cc && !bcc && !subject && !text;
    const handle = setTimeout(() => {
      if (isEmpty) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(
        key,
        JSON.stringify({ mailboxId, to, cc, bcc, subject, text, markdown } satisfies DraftData),
      );
      setSavedHint(true);
    }, 600);
    return () => clearTimeout(handle);
  }, [key, mailboxId, to, cc, bcc, subject, text, markdown]);

  const previewHtml = useMemo(() => {
    if (!markdown || !text.trim()) return "";
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [markdown, text]);

  const send = useMutation({
    mutationFn: async () => {
      const html = markdown && text.trim() ? previewHtml : undefined;
      const ccList = parseAddrs(cc);
      const bccList = parseAddrs(bcc);
      return api<{ messageId: string; threadId: string }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          mailboxId,
          to: parseAddrs(to),
          cc: ccList.length ? ccList : undefined,
          bcc: bccList.length ? bccList : undefined,
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
      localStorage.removeItem(key);
      closeCompose();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  function discard() {
    localStorage.removeItem(key);
    closeCompose();
  }

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
    <div className="fixed inset-0 z-40 flex flex-col overflow-hidden border bg-card shadow-xl shadow-black/10 sm:inset-auto sm:bottom-0 sm:right-6 sm:h-[540px] sm:w-[520px] sm:rounded-t-md sm:border-b-0">
      <div className="flex items-center justify-between border-b bg-muted px-3 py-1.5">
        <div className="text-[12px] font-semibold tracking-tight">
          {s.replyToMessage ? "Reply" : s.forwardMessage ? "Forward" : "New message"}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={closeCompose}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label="Close"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2 text-[13px]">
        <label className="flex items-center gap-2 border-b py-1">
          <span className="w-12 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
            From
          </span>
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
        <label className="flex items-center gap-2 border-b py-1">
          <span className="w-12 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
            To
          </span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            className="flex-1 bg-transparent outline-none"
          />
          {!showCc && (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cc/Bcc
            </button>
          )}
        </label>
        {showCc && (
          <>
            <label className="flex items-center gap-2 border-b py-1">
              <span className="w-12 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                Cc
              </span>
              <input
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="cc@example.com"
                className="flex-1 bg-transparent outline-none"
              />
            </label>
            <label className="flex items-center gap-2 border-b py-1">
              <span className="w-12 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                Bcc
              </span>
              <input
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                placeholder="bcc@example.com"
                className="flex-1 bg-transparent outline-none"
              />
            </label>
          </>
        )}
        <label className="flex items-center gap-2 border-b py-1">
          <span className="w-12 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
            Subject
          </span>
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
            className={cn(
              "flex-1 resize-none bg-transparent py-2 outline-none text-[13px]",
              markdown && "font-mono",
            )}
            placeholder={markdown ? "Write your message in markdown…" : "Write your message…"}
          />
        )}
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 border-t pt-2">
            {attachments.map((a) => (
              <li
                key={a.r2Key}
                className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px]"
              >
                <Paperclip className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
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
                  <X className="h-2.5 w-2.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => send.mutate()}
            disabled={send.isPending || uploading > 0 || !mailboxId || !to}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
          >
            {send.isPending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="h-3.5 w-3.5" />
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
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] font-medium transition",
              markdown
                ? "border-primary text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            aria-pressed={markdown}
            title="Toggle markdown"
          >
            MD
          </button>
          {markdown && (
            <button
              type="button"
              onClick={() => setPreview((v) => !v)}
              className="rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {preview ? "Edit" : "Preview"}
            </button>
          )}
          <button
            type="button"
            onClick={discard}
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="Discard draft"
            title="Discard draft"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {uploading > 0
            ? `Uploading ${uploading}…`
            : sendable.length === 0
              ? "No sendable mailboxes"
              : savedHint
                ? "Draft saved"
                : null}
        </span>
      </div>
    </div>
  );
}

function parseAddrs(value: string): { address: string }[] {
  return value
    .split(/[,;]\s*/)
    .filter(Boolean)
    .map((address) => ({ address }));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function prefixSubject(s: string, prefix: "Re" | "Fwd"): string {
  const re = prefix === "Re" ? /^re:/i : /^fwd:/i;
  if (re.test(s.trim())) return s;
  return `${prefix}: ${s}`;
}

function quoteForward(msg: MessageRow): string {
  const when = new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt).toLocaleString();
  const to = msg.toAddrs.map((a) => a.address).join(", ");
  return [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${msg.fromName ?? msg.fromAddr} <${msg.fromAddr}>`,
    `Date: ${when}`,
    `Subject: ${msg.subject}`,
    `To: ${to}`,
    "",
    msg.snippet,
  ].join("\n");
}
