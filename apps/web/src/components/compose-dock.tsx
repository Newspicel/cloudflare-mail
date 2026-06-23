import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { ExternalLink, Maximize2, Minimize2, Paperclip, Trash2, X } from "lucide-react";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import {
  contactsQuery,
  type DraftRow,
  type MessageRow,
  mailboxesQuery,
  messageBodyQuery,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import {
  AddressField,
  collectRecipients,
  hasRecipients,
  type RecipientsValue,
} from "./address-field.tsx";
import { EmailFrame } from "./email-frame.tsx";
import {
  FormatToolbar,
  htmlToText,
  type PendingCmd,
  RichEditor,
  type RichEditorHandle,
  textToHtml,
} from "./rich-editor.tsx";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

marked.setOptions({ breaks: true, gfm: true });

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

interface UploadedAttachment {
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface ComposeState {
  open: boolean;
  replyToMessage: MessageRow | null;
  // Reply-all: also carry over the original To/Cc recipients (minus ourselves).
  replyAll?: boolean;
  forwardMessage: MessageRow | null;
  initialTo?: string;
  // When set, the composer reopens an existing server-persisted draft.
  draft?: DraftRow | null;
}

type BodyFormat = "text" | "markdown" | "html";

interface DraftSnapshot {
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  bcc: { name?: string; address: string }[];
  subject: string;
  // For html mode this is the rich HTML; otherwise the plain/markdown source.
  body: string;
  format: BodyFormat;
  attachments: UploadedAttachment[];
}

const listeners = new Set<(s: ComposeState) => void>();
let state: ComposeState = { open: false, replyToMessage: null, forwardMessage: null };

// Compose-related user prefs, mirrored from the React Query cache by the always-
// mounted <ComposeDock> so the module-level openCompose() can honor them.
interface ComposePrefs {
  composeInNewWindow?: boolean;
  replyAllDefault?: boolean;
}
let composePrefs: ComposePrefs = {};
export function setComposePrefs(p: ComposePrefs): void {
  composePrefs = p;
}

export function openCompose(partial: Partial<ComposeState> = {}): void {
  const fresh = !partial.replyToMessage && !partial.forwardMessage && !partial.draft;
  // Pop a brand-new message out to its own window when preferred. Safe from the
  // popup blocker because openCompose runs inside the originating click/keydown.
  if (fresh && composePrefs.composeInNewWindow) {
    const url = partial.initialTo
      ? `/compose?to=${encodeURIComponent(partial.initialTo)}`
      : "/compose";
    if (window.open(url, "_blank", "popup,width=720,height=860")) return;
    // Popup blocked — fall back to the in-app dock.
  }
  // A reply defaults to reply-all when the user opted in (unless the caller,
  // e.g. the explicit "Reply all" button, set it).
  const replyAll = partial.replyToMessage
    ? (partial.replyAll ?? composePrefs.replyAllDefault ?? false)
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
  for (const l of listeners) l(state);
}
export function closeCompose(): void {
  state = { open: false, replyToMessage: null, forwardMessage: null };
  for (const l of listeners) l(state);
}

export function ComposeDock() {
  const [s, setS] = useState(state);
  const { prefs } = useUserPrefs();
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  // Keep the module-level cache that openCompose() reads in sync with prefs.
  useEffect(() => {
    setComposePrefs({
      composeInNewWindow: prefs.composeInNewWindow,
      replyAllDefault: prefs.replyAllDefault,
    });
  }, [prefs.composeInNewWindow, prefs.replyAllDefault]);
  if (!s.open) return null;
  // Remount when the target changes so the form re-initializes cleanly.
  return (
    <ComposeForm
      key={s.draft?.id ?? s.replyToMessage?.id ?? s.forwardMessage?.id ?? "new"}
      state={s}
    />
  );
}

// Shared row metrics so From/To/Subject share one default line height and the
// value text starts on the same baseline as the label, growing only on wrap.
const FIELD_ROW = "flex items-start gap-2 border-b py-1.5";
const FIELD_LABEL =
  "w-12 shrink-0 pt-1 text-[11px] text-muted-foreground uppercase tracking-wider leading-5";
const FIELD_INPUT =
  "flex-1 bg-transparent py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground";

export function ComposeForm({
  state: s,
  variant = "dock",
}: {
  state: ComposeState;
  // "dock" = the in-app floating panel; "window" = a standalone pop-out window.
  variant?: "dock" | "window";
}) {
  const isWindow = variant === "window";
  const qc = useQueryClient();
  const { prefs } = useUserPrefs();
  const { data: mailboxes } = useQuery(mailboxesQuery);
  const { data: contactsData } = useQuery(contactsQuery);
  const contacts = contactsData?.contacts ?? [];
  const sendable = (mailboxes?.mailboxes ?? []).filter((m) => (m.perms & 2) === 2);
  const d = s.draft;
  const rep = s.replyToMessage;
  const fwd = s.forwardMessage;
  // The original message to quote, as a stable {messageId, kind} ref. Works for
  // a live reply/forward and for a reopened draft that persisted its quote.
  const quoteRef = useMemo<{ messageId: string; kind: "reply" | "forward" } | null>(() => {
    if (rep) return { messageId: rep.id, kind: "reply" };
    if (fwd) return { messageId: fwd.id, kind: "forward" };
    if (d?.quoteMessageId && d.quoteKind) return { messageId: d.quoteMessageId, kind: d.quoteKind };
    return null;
  }, [rep, fwd, d]);

  // Addresses that are "us" — excluded from reply-all recipients so we don't
  // reply to ourselves. The reply mailbox's own address plus the envelope
  // recipient the mail was delivered to.
  const selfAddrs = useMemo(() => {
    const set = new Set<string>();
    const mbAddr = (mailboxes?.mailboxes ?? [])
      .find((m) => m.id === rep?.mailboxId)
      ?.address?.toLowerCase();
    if (mbAddr) set.add(mbAddr);
    if (rep?.deliveredTo) set.add(rep.deliveredTo.toLowerCase());
    return set;
  }, [mailboxes, rep]);

  const [mailboxId, setMailboxId] = useState(
    d?.mailboxId ?? rep?.mailboxId ?? fwd?.mailboxId ?? sendable[0]?.id ?? "",
  );
  const [to, setTo] = useState<RecipientsValue>(() => {
    if (d) return { items: d.toAddrs ?? [], input: "" };
    if (rep) {
      const items = uniqueRecipients(
        [
          { address: rep.fromAddr, name: rep.fromName ?? undefined },
          ...(s.replyAll ? (rep.toAddrs ?? []) : []),
        ],
        selfAddrs,
      );
      return { items, input: "" };
    }
    if (s.initialTo) return { items: [{ address: s.initialTo }], input: "" };
    return { items: [], input: "" };
  });
  const [cc, setCc] = useState<RecipientsValue>(() => {
    if (d) return { items: d.ccAddrs ?? [], input: "" };
    if (rep && s.replyAll) {
      const exclude = new Set(selfAddrs);
      for (const a of to.items) exclude.add(a.address.toLowerCase());
      return { items: uniqueRecipients(rep.ccAddrs ?? [], exclude), input: "" };
    }
    return { items: [], input: "" };
  });
  const [bcc, setBcc] = useState<RecipientsValue>(() => ({ items: d?.bccAddrs ?? [], input: "" }));
  const [showCc, setShowCc] = useState(
    Boolean((d?.ccAddrs?.length ?? 0) || (d?.bccAddrs?.length ?? 0) || cc.items.length),
  );
  const [showQuote, setShowQuote] = useState(false);
  const [subject, setSubject] = useState(
    d
      ? d.subject
      : rep
        ? prefixSubject(rep.subject, "Re")
        : fwd
          ? prefixSubject(fwd.subject, "Fwd")
          : "",
  );
  // Body editor format. Default is a plain-text email; it only becomes an HTML
  // mail once rich formatting is actually used (or markdown is rendered).
  const initialFormat: BodyFormat =
    d?.format ?? (d?.markdown ? "markdown" : (prefs.composeDefaultMode ?? "text"));
  const [mode, setMode] = useState<BodyFormat>(initialFormat);
  // `text` holds the plain/markdown source; `html` holds the rich-mode body.
  const [text, setText] = useState(d && initialFormat !== "html" ? d.body : "");
  const [html, setHtml] = useState(d && initialFormat === "html" ? d.body : "");
  const editorRef = useRef<RichEditorHandle>(null);
  // A format command queued while still in plain text — applied once the editor
  // mounts after promotion to HTML.
  const pendingCmdRef = useRef<PendingCmd | null>(null);

  // The original body, fetched for the quoted-message preview. The server
  // re-quotes from the raw `.eml` at send time (mail/quote.ts); this is only so
  // the composer can show what's being included.
  const origBody = useQuery({
    ...messageBodyQuery(quoteRef?.messageId ?? ""),
    enabled: Boolean(quoteRef),
  });
  const quotedHtml = useMemo(
    () => (origBody.data?.html ? sanitizeEmailHtml(origBody.data.html) : null),
    [origBody.data?.html],
  );
  const [preview, setPreview] = useState(false);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>(d?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [savedHint, setSavedHint] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Threading context: a reopened draft carries it; a fresh reply derives it
  // from the message being answered.
  const inReplyTo = d?.inReplyTo ?? rep?.messageIdHdr ?? undefined;
  const references =
    d?.references ??
    (rep
      ? [...(rep.references ?? []), rep.messageIdHdr].filter((x): x is string => Boolean(x))
      : undefined);

  // ── Server-persisted drafts ────────────────────────────────────────────
  const draftIdRef = useRef<string | null>(d?.id ?? null);
  const initialKeyRef = useRef<string | null>(null);
  const saveRef = useRef<{
    saving: boolean;
    queued: { snap: DraftSnapshot; isEmpty: boolean } | null;
  }>({
    saving: false,
    queued: null,
  });

  const invalidateDrafts = useCallback(() => {
    if (!mailboxId) return;
    qc.invalidateQueries({ queryKey: keys.drafts(mailboxId) });
    // Refresh the Drafts badge count (keyed under the threads prefix).
    qc.invalidateQueries({ queryKey: keys.folderCounts(mailboxId) });
  }, [qc, mailboxId]);

  const deleteDraft = useCallback(async () => {
    const id = draftIdRef.current;
    if (!id) return;
    draftIdRef.current = null;
    await api(`/api/drafts/${id}`, { method: "DELETE" });
    invalidateDrafts();
  }, [invalidateDrafts]);

  const flush = useCallback(
    async (data: { snap: DraftSnapshot; isEmpty: boolean }) => {
      const st = saveRef.current;
      if (st.saving) {
        st.queued = data;
        return;
      }
      st.saving = true;
      try {
        if (data.isEmpty) {
          await deleteDraft();
        } else {
          const payload = { ...data.snap, inReplyTo, references, quote: quoteRef };
          if (draftIdRef.current) {
            await api(`/api/drafts/${draftIdRef.current}`, {
              method: "PATCH",
              body: JSON.stringify(payload),
            });
          } else {
            const res = await api<{ draft: { id: string } }>("/api/drafts", {
              method: "POST",
              body: JSON.stringify({ mailboxId, ...payload }),
            });
            draftIdRef.current = res.draft.id;
          }
          setSavedHint(true);
          invalidateDrafts();
        }
      } catch {
        // Autosave is best-effort; surface nothing on transient failures.
      } finally {
        st.saving = false;
        const q = st.queued;
        st.queued = null;
        if (q) void flush(q);
      }
    },
    [mailboxId, inReplyTo, references, quoteRef, deleteDraft, invalidateDrafts],
  );

  // The current form state as a draft snapshot + whether it's effectively blank.
  const currentSnapshot = useCallback((): { snap: DraftSnapshot; isEmpty: boolean } => {
    const toList = collectRecipients(to);
    const ccList = collectRecipients(cc);
    const bccList = collectRecipients(bcc);
    const body = mode === "html" ? html : text;
    const snap: DraftSnapshot = {
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject,
      body,
      format: mode,
      attachments,
    };
    const bodyText = mode === "html" ? htmlToText(html) : text;
    const isEmpty =
      !toList.length &&
      !ccList.length &&
      !bccList.length &&
      !subject &&
      !bodyText.trim() &&
      attachments.length === 0;
    return { snap, isEmpty };
  }, [to, cc, bcc, subject, text, html, mode, attachments]);

  // Debounced autosave. Skips while the form is untouched (so merely opening a
  // reply/forward doesn't spawn a draft) and serializes writes via `flush`.
  useEffect(() => {
    const { snap, isEmpty } = currentSnapshot();
    const key = JSON.stringify(snap);
    if (initialKeyRef.current === null) initialKeyRef.current = key;
    if (key === initialKeyRef.current) return;
    const handle = setTimeout(() => void flush({ snap, isEmpty }), 700);
    return () => clearTimeout(handle);
  }, [currentSnapshot, flush]);

  // Persist the current state and resolve the draft id — used by the pop-out so
  // the new window can rehydrate from the server-saved draft. Returns null only
  // when there is genuinely nothing to carry over.
  const ensureDraftSaved = useCallback(async (): Promise<string | null> => {
    const { snap, isEmpty } = currentSnapshot();
    if (isEmpty) return draftIdRef.current;
    await flush({ snap, isEmpty: false });
    return draftIdRef.current;
  }, [currentSnapshot, flush]);

  const previewHtml = useMemo(() => {
    if (mode !== "markdown" || !text.trim()) return "";
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [mode, text]);

  const send = useMutation({
    mutationFn: async () => {
      // Plain text → text only. Markdown → text source + rendered html. Rich →
      // sanitized html + a derived text alternative for non-HTML clients.
      let textBody: string | undefined;
      let htmlBody: string | undefined;
      if (mode === "html") {
        htmlBody = html.trim()
          ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
          : undefined;
        textBody = htmlBody ? htmlToText(html) || undefined : undefined;
      } else if (mode === "markdown") {
        textBody = text;
        htmlBody = text.trim() ? previewHtml : undefined;
      } else {
        textBody = text;
      }
      const ccList = collectRecipients(cc);
      const bccList = collectRecipients(bcc);
      return api<{ messageId: string; threadId: string }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          mailboxId,
          to: collectRecipients(to),
          cc: ccList.length ? ccList : undefined,
          bcc: bccList.length ? bccList : undefined,
          subject,
          text: textBody,
          html: htmlBody,
          inReplyTo,
          references,
          quote: quoteRef ?? undefined,
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
    onSuccess: async () => {
      toast.success("Message sent");
      if (mailboxId) qc.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
      // Keep the combined "All" view's lists/counts in sync with the send.
      qc.invalidateQueries({ queryKey: keys.threadsRoot("all") });
      await deleteDraft().catch(() => {});
      finish();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  // Close the dock, or close the OS window when running as a pop-out.
  function finish() {
    if (isWindow) window.close();
    else closeCompose();
  }

  function discard() {
    void deleteDraft().catch(() => {});
    finish();
  }

  // Persist the in-progress message and reopen it in a real browser window.
  // window.open must run synchronously inside the click to dodge popup blockers,
  // so the window is created first and pointed at the route once the draft id
  // is known.
  function popOut() {
    const w = window.open("about:blank", "_blank", "popup,width=720,height=860");
    if (!w) {
      toast.error("Allow pop-ups to open the message in a new window");
      return;
    }
    void (async () => {
      let url = "/compose";
      try {
        const id = await ensureDraftSaved();
        if (id) url += `?draft=${encodeURIComponent(id)}`;
        else if (s.initialTo) url += `?to=${encodeURIComponent(s.initialTo)}`;
      } catch {
        // Fall back to a blank composer rather than leaving a dead window.
      }
      w.location.replace(url);
      closeCompose();
    })();
  }

  // Guard against the classic "forgot the attachment". Only the body the user
  // actually composed is scanned — the quoted reply/forward original lives
  // server-side and never reaches here, so it can't trip a false warning.
  function attemptSend() {
    const composed = mode === "html" ? htmlToText(html) : text;
    if (attachments.length === 0 && uploading === 0 && mentionsAttachment(composed)) {
      const ok = window.confirm(
        "It looks like you mentioned an attachment, but nothing is attached.\n\nSend anyway?",
      );
      if (!ok) return;
    }
    send.mutate();
  }

  // ⌘/Ctrl+Enter sends, when enabled in preferences. Bound on the compose
  // container so it only fires while the composer is focused.
  function onContainerKeyDown(e: React.KeyboardEvent) {
    if (!prefs.sendShortcut) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!send.isPending && uploading === 0 && mailboxId && hasRecipients(to)) attemptSend();
    }
  }

  // A formatting tool was used. In HTML mode run it directly; otherwise promote
  // the plain-text body to HTML and queue the command for the mounting editor.
  function runFormat(cmd: string, value?: string) {
    if (mode === "html") {
      editorRef.current?.exec(cmd, value);
      return;
    }
    setHtml(textToHtml(text));
    pendingCmdRef.current = { cmd, value };
    setMode("html");
  }

  // Drop rich formatting back to a plain-text body.
  function exitRich() {
    setText(htmlToText(html));
    pendingCmdRef.current = null;
    setMode("text");
  }

  function toggleMarkdown() {
    if (mode === "markdown") {
      setPreview(false);
      setMode("text");
      return;
    }
    if (mode === "html") setText(htmlToText(html));
    pendingCmdRef.current = null;
    setMode("markdown");
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

  const titleText = rep
    ? s.replyAll
      ? "Reply all"
      : "Reply"
    : fwd
      ? "Forward"
      : quoteRef?.kind === "reply"
        ? "Reply"
        : quoteRef?.kind === "forward"
          ? "Forward"
          : "New message";

  const content = (
    <>
      <div className="flex items-center justify-between border-b bg-muted/60 px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:pt-2.5">
        {isWindow ? (
          <span className="font-semibold text-[13px] text-foreground tracking-tight">
            {titleText}
          </span>
        ) : (
          <Dialog.Title className="font-semibold text-[13px] text-foreground tracking-tight">
            {titleText}
          </Dialog.Title>
        )}
        <div className="flex items-center gap-0.5">
          {!isWindow && (
            <>
              <button
                type="button"
                onClick={popOut}
                className="hidden h-6 w-6 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 sm:grid"
                aria-label="Open in new window"
                title="Open in new window"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="hidden h-6 w-6 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 sm:grid"
                aria-label={expanded ? "Shrink" : "Expand"}
                aria-pressed={expanded}
              >
                {expanded ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </button>
            </>
          )}
          {isWindow ? (
            <button
              type="button"
              onClick={() => window.close()}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Dialog.Close
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Dialog.Close>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-1">
        <div className={FIELD_ROW}>
          <span className={FIELD_LABEL}>From</span>
          <Select value={mailboxId} onValueChange={(v) => setMailboxId(v as string)}>
            <SelectTrigger
              aria-label="From mailbox"
              className="h-auto w-auto flex-1 justify-between gap-1 border-0 bg-transparent px-0 py-0.5 text-left text-[13px] leading-5 shadow-none hover:bg-transparent focus-visible:ring-0"
            >
              <SelectValue>
                {(value) => sendable.find((m) => m.id === value)?.address ?? ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {sendable.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AddressField
          label="To"
          value={to}
          onChange={setTo}
          placeholder="name@example.com"
          contacts={contacts}
          trailing={
            !showCc && (
              <button
                type="button"
                onClick={() => setShowCc(true)}
                className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Cc/Bcc
              </button>
            )
          }
        />
        {showCc && (
          <>
            <AddressField
              label="Cc"
              value={cc}
              onChange={setCc}
              placeholder="cc@example.com"
              contacts={contacts}
            />
            <AddressField
              label="Bcc"
              value={bcc}
              onChange={setBcc}
              placeholder="bcc@example.com"
              contacts={contacts}
            />
          </>
        )}
        <label className={FIELD_ROW}>
          <span className={FIELD_LABEL}>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={FIELD_INPUT}
          />
        </label>
        <FormatToolbar
          mode={mode}
          onExec={runFormat}
          onToggleMarkdown={toggleMarkdown}
          preview={preview}
          onTogglePreview={() => setPreview((v) => !v)}
          onExitRich={exitRich}
        />
        {mode === "html" ? (
          <RichEditor
            ref={editorRef}
            initialHtml={html}
            pendingCmd={pendingCmdRef.current}
            onChange={setHtml}
            placeholder="Write your message…"
          />
        ) : mode === "markdown" && preview ? (
          <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify
            dangerouslySetInnerHTML={{ __html: previewHtml }}
            className="prose prose-sm max-w-none flex-1 overflow-y-auto py-2 dark:prose-invert"
          />
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={cn(
              "min-h-40 flex-1 resize-none border-0 bg-transparent px-0 py-2 shadow-none focus-visible:ring-0",
              mode === "markdown" && "font-mono",
            )}
            placeholder={
              mode === "markdown" ? "Write your message in markdown…" : "Write your message…"
            }
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
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
                  aria-label={`Remove ${a.filename}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {quoteRef && (
          <div className="mt-2 border-t pt-2">
            <button
              type="button"
              onClick={() => setShowQuote((v) => !v)}
              className="rounded px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {showQuote ? "Hide" : "Show"} quoted message
            </button>
            <p className="mt-0.5 px-1.5 text-[11px] text-muted-foreground/70">
              The original message is included below your{" "}
              {quoteRef.kind === "forward" ? "forward" : "reply"}.
            </p>
            {showQuote && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-md border bg-muted/30">
                {quotedHtml ? (
                  // Same sandboxed isolation as the message view — the quoted
                  // body is untrusted mail too.
                  <EmailFrame html={quotedHtml} />
                ) : (
                  <pre className="whitespace-pre-wrap px-3 py-2 font-sans text-[12px] text-muted-foreground">
                    {origBody.data?.text ?? rep?.snippet ?? fwd?.snippet ?? ""}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant="primary"
            onClick={attemptSend}
            disabled={send.isPending || uploading > 0 || !mailboxId || !hasRecipients(to)}
          >
            {send.isPending ? "Sending…" : "Send"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            aria-label="Attach files"
          >
            <Paperclip />
          </Button>
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
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {uploading > 0
              ? `Uploading ${uploading}…`
              : sendable.length === 0
                ? "No sendable mailboxes"
                : savedHint
                  ? "Draft saved"
                  : null}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={discard}
            className="hover:bg-destructive/10 hover:text-destructive"
            aria-label="Discard draft"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </>
  );

  if (isWindow) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: container-level ⌘/Ctrl+Enter send shortcut; inner fields stay the focus targets
      <div
        onKeyDown={onContainerKeyDown}
        className="flex h-dvh flex-col overflow-hidden bg-card text-card-foreground"
      >
        {content}
      </div>
    );
  }
  return (
    <Dialog.Root
      open
      modal="trap-focus"
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next) closeCompose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          onKeyDown={onContainerKeyDown}
          className={cn(
            "fixed inset-0 z-40 flex flex-col overflow-hidden border bg-card text-card-foreground shadow-black/20 shadow-2xl outline-none transition-all duration-200 data-ending-style:translate-y-3 data-ending-style:opacity-0 data-starting-style:translate-y-3 data-starting-style:opacity-0 sm:inset-auto sm:right-6 sm:bottom-0 sm:rounded-t-xl sm:border-b-0",
            expanded
              ? "sm:h-[88vh] sm:max-h-[860px] sm:w-[760px] sm:max-w-[calc(100vw-3rem)]"
              : "sm:h-[560px] sm:w-[516px]",
          )}
        >
          {content}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Words that usually imply a file is coming, across the languages most likely
// to show up in this inbox. Stems are matched whole (letter boundaries), so
// "attach" won't fire inside an unrelated longer word.
const ATTACHMENT_WORDS = [
  // English
  "attach",
  "attached",
  "attachment",
  "attachments",
  "attaching",
  "enclosed",
  "enclosure",
  "enclosures",
  // German
  "anbei",
  "anhang",
  "anhänge",
  "angehängt",
  "angehaengt",
  "beigefügt",
  "beigefuegt",
  "beiliegend",
  // French
  "ci-joint",
  "ci-jointe",
  "pièce jointe",
  "pièces jointes",
  "piece jointe",
  // Spanish
  "adjunto",
  "adjunta",
  "adjuntos",
  "adjuntas",
  // Italian
  "allegato",
  "allegata",
  "allegati",
  "allegate",
  // Dutch
  "bijlage",
  "bijgevoegd",
  // Portuguese
  "anexo",
  "anexado",
  "anexada",
  "anexados",
];

// Letter-boundary match (Unicode-aware, so umlauts/accents bound correctly).
const ATTACHMENT_MENTION_RE = new RegExp(
  `(?<!\\p{L})(?:${ATTACHMENT_WORDS.join("|")})(?!\\p{L})`,
  "iu",
);

function mentionsAttachment(body: string): boolean {
  return body.trim().length > 0 && ATTACHMENT_MENTION_RE.test(body);
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

// Dedupes a recipient list (case-insensitive), dropping any address in `exclude`.
function uniqueRecipients(
  items: { name?: string; address: string }[],
  exclude: Set<string>,
): { name?: string; address: string }[] {
  const out: { name?: string; address: string }[] = [];
  const seen = new Set(exclude);
  for (const a of items) {
    const key = a.address.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ address: a.address, name: a.name });
  }
  return out;
}
