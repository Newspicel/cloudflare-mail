import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  ExternalLink,
  FileText,
  ImageIcon,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  Trash2,
  X,
} from "lucide-react";
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
  meQuery,
  messageBodyQuery,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { canDownscale, downscaleImage } from "@/lib/resize-image.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { canStripMetadata, stripImageMetadata } from "@/lib/strip-image-metadata.ts";
import { fillTemplate, type TemplateContext } from "@/lib/templates.ts";
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
import { Calendar } from "./ui/calendar.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dialog as ImageChoiceDialog,
} from "./ui/dialog.tsx";
import { Label } from "./ui/label.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { ToggleGroup, ToggleItem } from "./ui/toggle-group.tsx";

marked.setOptions({ breaks: true, gfm: true });

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

// ── Scheduled-send time helpers ──────────────────────────────────────────────
// Stamp a "HH:mm" wall-clock time onto a calendar day, in the user's local zone.
function combineDateTime(day: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const out = new Date(day);
  out.setHours(h ?? 0, m ?? 0, 0, 0);
  return out;
}

function atHour(d: Date, hour: number): Date {
  const out = new Date(d);
  out.setHours(hour, 0, 0, 0);
  return out;
}

// The next occurrence of `weekday` (0=Sun..6=Sat) at `hour`, always in the
// future — today counts only if `hour` hasn't passed yet.
function nextWeekday(weekday: number, hour: number): Date {
  const now = new Date();
  let delta = (weekday - now.getDay() + 7) % 7;
  if (delta === 0 && atHour(now, hour).getTime() <= now.getTime()) delta = 7;
  const d = new Date(now);
  d.setDate(d.getDate() + delta);
  return atHour(d, hour);
}

function schedulePresets(): { label: string; when: Date }[] {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [
    { label: "In 1 hour", when: new Date(now.getTime() + 60 * 60 * 1000) },
    { label: "In 3 hours", when: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
    { label: "Tomorrow morning", when: atHour(tomorrow, 8) },
    { label: "Monday morning", when: nextWeekday(1, 8) },
  ];
}

function formatWhen(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface UploadedAttachment {
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // Inline image embedded in the HTML body; `contentId` is its bare cid token,
  // referenced from the body as `cid:<contentId>` and rewritten at send time.
  inline?: boolean;
  contentId?: string;
}

// Marks an <img> in the rich editor as an inline attachment. The preview src
// points at the draft blob; buildBody swaps it for `cid:<contentId>` on send.
const CID_ATTR = "data-cfmail-cid";

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Rewrite inline-image <img> tags (those carrying CID_ATTR) so their src points
// at `cid:<contentId>` for the outbound HTML, and report which content ids are
// actually still referenced (the user may have deleted an embedded image).
function resolveInlineImages(html: string): { html: string; usedCids: Set<string> } {
  const usedCids = new Set<string>();
  if (typeof document === "undefined" || !html.includes(CID_ATTR)) {
    return { html, usedCids };
  }
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  for (const img of doc.querySelectorAll(`img[${CID_ATTR}]`)) {
    const cid = img.getAttribute(CID_ATTR);
    if (!cid) continue;
    usedCids.add(cid);
    img.setAttribute("src", `cid:${cid}`);
    img.removeAttribute(CID_ATTR);
  }
  return { html: doc.body.innerHTML, usedCids };
}

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

type BodyFormat = "text" | "markdown" | "html";

interface DraftSnapshot {
  // Plus-alias sender override (e.g. "hi+tag@"), or null for the mailbox's own
  // address. Pairs with the snapshot's mailbox (tracked separately).
  fromAddress: string | null;
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  bcc: { name?: string; address: string }[];
  subject: string;
  // For html mode this is the rich HTML; otherwise the plain/markdown source.
  body: string;
  format: BodyFormat;
  attachments: UploadedAttachment[];
}

// A queued/in-flight autosave: the snapshot, whether it's blank (→ delete), and
// `key` so the close/unload paths can mark it persisted. `keepalive` keeps the
// request alive past an unmount or tab close.
interface DraftFlush {
  snap: DraftSnapshot;
  isEmpty: boolean;
  key: string;
  keepalive?: boolean;
}

const listeners = new Set<(s: ComposeState) => void>();
let state: ComposeState = {
  open: false,
  replyToMessage: null,
  forwardMessage: null,
};

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

// Preview URL for an inline image still held under a draft R2 key.
function draftBlobUrl(r2Key: string): string {
  return `/api/attachments/draft-blob?key=${encodeURIComponent(r2Key)}`;
}

// Only OS file drags carry the "Files" type, so other drag types never trip
// the attach overlay.
function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

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
  const { data: meData } = useQuery(meQuery);
  const templates = prefs.templates ?? [];
  const contacts = contactsData?.contacts ?? [];
  const sendable = (mailboxes?.mailboxes ?? []).filter((m) => (m.perms & 2) === 2);
  const d = s.draft;
  const rep = s.replyToMessage;
  const fwd = s.forwardMessage;
  // The original message to quote, as a stable {messageId, kind} ref. Works for
  // a live reply/forward and for a reopened draft that persisted its quote.
  const quoteRef = useMemo<{
    messageId: string;
    kind: "reply" | "forward";
  } | null>(() => {
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
  // Sender override: a plus-alias of the chosen mailbox, or null for its own
  // address. On reply, default to the sub-address the mail was delivered to
  // (hi+tag@) so the answer goes out from the same alias.
  const [fromAddress, setFromAddress] = useState<string | null>(() => {
    if (d) return d.fromAddress ?? null;
    const dt = rep?.deliveredTo;
    const mbAddr = sendable.find((m) => m.id === rep?.mailboxId)?.address;
    if (
      dt &&
      mbAddr &&
      dt.toLowerCase() !== mbAddr.toLowerCase() &&
      plusBase(dt) === mbAddr.toLowerCase()
    )
      return dt;
    return null;
  });
  const baseAddr = useCallback(
    (id: string) => sendable.find((m) => m.id === id)?.address ?? "",
    [sendable],
  );
  // Custom plus-aliases the user typed in compose, so they stay selectable.
  const [customAliases, setCustomAliases] = useState<{ address: string; mailboxId: string }[]>(
    () => {
      if (d?.fromAddress && plusBase(d.fromAddress))
        return [{ address: d.fromAddress, mailboxId: d.mailboxId }];
      return [];
    },
  );
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusTag, setPlusTag] = useState("");
  // Selectable "From" addresses: each sendable mailbox, the plus-addressed
  // envelope recipient when replying to one, plus any custom alias the user added.
  const fromOptions = useMemo(() => {
    const opts = sendable.map((m) => ({ address: m.address, mailboxId: m.id }));
    const dt = rep?.deliveredTo;
    const mb = sendable.find((m) => m.id === rep?.mailboxId);
    if (
      dt &&
      mb &&
      plusBase(dt) === mb.address.toLowerCase() &&
      !opts.some((o) => o.address.toLowerCase() === dt.toLowerCase())
    )
      opts.push({ address: dt, mailboxId: mb.id });
    for (const c of customAliases)
      if (!opts.some((o) => o.address.toLowerCase() === c.address.toLowerCase())) opts.push(c);
    return opts;
  }, [sendable, rep, customAliases]);
  const currentFrom = fromAddress ?? baseAddr(mailboxId);
  // Apply the "+tag" typed in the picker as a sub-address of the chosen mailbox.
  const applyPlusTag = useCallback(() => {
    const base = baseAddr(mailboxId);
    const at = base.lastIndexOf("@");
    if (at <= 0) return;
    const tag = plusTag.trim().replace(/^\++/, "").replace(/\s+/g, "");
    const addr = tag ? `${base.slice(0, at)}+${tag}@${base.slice(at + 1)}` : base;
    if (tag)
      setCustomAliases((prev) =>
        prev.some((c) => c.address.toLowerCase() === addr.toLowerCase())
          ? prev
          : [...prev, { address: addr, mailboxId }],
      );
    setFromAddress(tag ? addr : null);
    setPlusOpen(false);
    setPlusTag("");
  }, [baseAddr, mailboxId, plusTag]);
  // PGP policy of the selected sending mailbox — drives the compose indicator.
  const pgpMode = sendable.find((m) => m.id === mailboxId)?.pgpMode ?? "off";
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
  const [bcc, setBcc] = useState<RecipientsValue>(() => ({
    items: d?.bccAddrs ?? [],
    input: "",
  }));
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
  // A seeded body (AI smart-reply) opens in plain text so it lands in the text
  // buffer regardless of the user's default editor.
  const initialFormat: BodyFormat =
    d?.format ??
    (d?.markdown ? "markdown" : s.initialBody ? "text" : (prefs.composeDefaultMode ?? "text"));
  const [mode, setMode] = useState<BodyFormat>(initialFormat);
  // `text` holds the plain/markdown source; `html` holds the rich-mode body.
  const [text, setText] = useState(d && initialFormat !== "html" ? d.body : (s.initialBody ?? ""));
  const [html, setHtml] = useState(d && initialFormat === "html" ? d.body : "");
  const editorRef = useRef<RichEditorHandle>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined);
  const [customTime, setCustomTime] = useState("09:00");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Files being dragged over the composer (overlay) and the pending batch of
  // dropped/picked images awaiting an attach-vs-inline + strip-metadata choice.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [stripMeta, setStripMeta] = useState(true);
  const [placement, setPlacement] = useState<"attachment" | "inline">("inline");
  // Longest-edge cap applied to pending images before upload; 0 = keep original.
  const [resizeMax, setResizeMax] = useState(0);

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
  // Key of the snapshot last persisted (or the initial, untouched state). Lets
  // the close/unload handlers tell whether there's an unsaved edit to flush.
  const savedKeyRef = useRef<string | null>(null);
  // The most recent snapshot, kept current so close/unmount can flush the last
  // <700ms of typing that the debounce timer would otherwise drop.
  const latestRef = useRef<DraftFlush | null>(null);
  const saveRef = useRef<{
    saving: boolean;
    queued: DraftFlush | null;
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

  const deleteDraft = useCallback(
    async (keepalive?: boolean) => {
      const id = draftIdRef.current;
      if (!id) return;
      draftIdRef.current = null;
      await api(`/api/drafts/${id}`, { method: "DELETE", keepalive });
      invalidateDrafts();
    },
    [invalidateDrafts],
  );

  const flush = useCallback(
    async (data: DraftFlush) => {
      const st = saveRef.current;
      if (st.saving) {
        st.queued = data;
        return;
      }
      st.saving = true;
      try {
        if (data.isEmpty) {
          await deleteDraft(data.keepalive);
        } else {
          const payload = {
            ...data.snap,
            inReplyTo,
            references,
            quote: quoteRef,
          };
          if (draftIdRef.current) {
            await api(`/api/drafts/${draftIdRef.current}`, {
              method: "PATCH",
              body: JSON.stringify(payload),
              keepalive: data.keepalive,
            });
          } else {
            const res = await api<{ draft: { id: string } }>("/api/drafts", {
              method: "POST",
              body: JSON.stringify({ mailboxId, ...payload }),
              keepalive: data.keepalive,
            });
            draftIdRef.current = res.draft.id;
          }
          setSavedHint(true);
          invalidateDrafts();
        }
        savedKeyRef.current = data.key;
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
  const currentSnapshot = useCallback((): {
    snap: DraftSnapshot;
    isEmpty: boolean;
  } => {
    const toList = collectRecipients(to);
    const ccList = collectRecipients(cc);
    const bccList = collectRecipients(bcc);
    const body = mode === "html" ? html : text;
    const snap: DraftSnapshot = {
      fromAddress,
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
  }, [fromAddress, to, cc, bcc, subject, text, html, mode, attachments]);

  // Debounced autosave. Skips while the form is untouched (so merely opening a
  // reply/forward doesn't spawn a draft) and serializes writes via `flush`.
  useEffect(() => {
    const { snap, isEmpty } = currentSnapshot();
    const key = JSON.stringify(snap);
    if (initialKeyRef.current === null) {
      initialKeyRef.current = key;
      savedKeyRef.current = key;
    }
    latestRef.current = { snap, isEmpty, key };
    if (key === savedKeyRef.current) return;
    const handle = setTimeout(() => void flush({ snap, isEmpty, key }), 700);
    return () => clearTimeout(handle);
  }, [currentSnapshot, flush]);

  // Flush the last edit when the composer closes or the tab is torn down — the
  // debounce timer is cancelled on unmount, so without this the final <700ms of
  // typing is lost. `keepalive` lets the request outlive the page on tab close.
  useEffect(() => {
    const flushPending = (keepalive: boolean) => {
      const latest = latestRef.current;
      if (!latest || latest.key === savedKeyRef.current) return;
      savedKeyRef.current = latest.key;
      void flush({ ...latest, keepalive });
    };
    const onUnload = () => flushPending(true);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      flushPending(false);
    };
  }, [flush]);

  // Persist the current state and resolve the draft id — used by the pop-out so
  // the new window can rehydrate from the server-saved draft. Returns null only
  // when there is genuinely nothing to carry over.
  const ensureDraftSaved = useCallback(async (): Promise<string | null> => {
    const { snap, isEmpty } = currentSnapshot();
    if (isEmpty) return draftIdRef.current;
    const key = JSON.stringify(snap);
    savedKeyRef.current = key;
    await flush({ snap, isEmpty: false, key });
    return draftIdRef.current;
  }, [currentSnapshot, flush]);

  const previewHtml = useMemo(() => {
    if (mode !== "markdown" || !text.trim()) return "";
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [mode, text]);

  // Resolve the editor state into the wire body: plain text → text only;
  // markdown → text source + rendered html; rich → sanitized html plus a derived
  // text alternative for non-HTML clients. Shared by immediate + scheduled send.
  const buildBody = useCallback((): {
    text: string | undefined;
    html: string | undefined;
  } => {
    if (mode === "html") {
      const { html: resolved } = resolveInlineImages(html);
      const htmlBody = resolved.trim()
        ? DOMPurify.sanitize(resolved, { USE_PROFILES: { html: true } })
        : undefined;
      return { html: htmlBody, text: htmlBody ? htmlToText(html) || undefined : undefined };
    }
    if (mode === "markdown") {
      return { text, html: text.trim() ? previewHtml : undefined };
    }
    return { text, html: undefined };
  }, [mode, html, text, previewHtml]);

  // The full outbound payload — identical whether the send fires now or later.
  const buildSendPayload = useCallback(() => {
    const body = buildBody();
    const ccList = collectRecipients(cc);
    const bccList = collectRecipients(bcc);
    // Drop inline images whose <img> was removed from the body; they're dead
    // weight that would arrive as orphaned, never-rendered attachments.
    const usedCids = mode === "html" ? resolveInlineImages(html).usedCids : new Set<string>();
    const outAttachments = attachments.filter(
      (a) => !a.inline || (a.contentId ? usedCids.has(a.contentId) : false),
    );
    return {
      mailboxId,
      fromAddress: fromAddress ?? undefined,
      to: collectRecipients(to),
      cc: ccList.length ? ccList : undefined,
      bcc: bccList.length ? bccList : undefined,
      subject,
      text: body.text,
      html: body.html,
      inReplyTo,
      references,
      quote: quoteRef ?? undefined,
      attachments: outAttachments.length
        ? outAttachments.map((a) => ({
            r2Key: a.r2Key,
            filename: a.filename,
            contentType: a.contentType,
            ...(a.inline ? { inline: true, contentId: a.contentId } : {}),
          }))
        : undefined,
    };
  }, [
    buildBody,
    cc,
    bcc,
    to,
    mailboxId,
    fromAddress,
    subject,
    inReplyTo,
    references,
    quoteRef,
    attachments,
    mode,
    html,
  ]);

  const send = useMutation({
    mutationFn: async () =>
      api<{ messageId: string; threadId: string; pgpWarning?: string }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify(buildSendPayload()),
      }),
    onSuccess: async (res) => {
      if (res?.pgpWarning) toast.warning(res.pgpWarning);
      else toast.success("Message sent");
      if (mailboxId) qc.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
      // Keep the combined "All" view's lists/counts in sync with the send.
      qc.invalidateQueries({ queryKey: keys.threadsRoot("all") });
      await deleteDraft().catch(() => {});
      // The message is sent and the draft removed — don't let the close-flush
      // resurrect it on unmount.
      latestRef.current = null;
      finish();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  // Defer the send: persist the draft, then hand the server the resolved payload
  // + target time. The draft becomes the scheduled record (visible/cancelable in
  // Drafts) rather than being deleted.
  const schedule = useMutation({
    mutationFn: async (sendAt: number) => {
      const id = await ensureDraftSaved();
      if (!id) throw new Error("Nothing to schedule");
      return api(`/api/drafts/${id}/schedule`, {
        method: "POST",
        body: JSON.stringify({ sendAt, payload: buildSendPayload() }),
      });
    },
    onSuccess: (_res, sendAt) => {
      toast.success(`Send scheduled for ${new Date(sendAt).toLocaleString()}`);
      invalidateDrafts();
      // The draft now holds the scheduled payload — suppress the close-flush so
      // unmount doesn't PATCH a stale edit over it.
      latestRef.current = null;
      finish();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to schedule");
    },
  });

  // Warn when a committed recipient is on the deployment blocklist — they can't
  // reach this server, so a reply would bounce. Only committed chips are checked
  // (not the in-progress input), and the query is keyed by the address set so
  // identical sets are served from cache rather than refetched on every keystroke.
  const recipientAddrs = useMemo(() => {
    const all = [...to.items, ...cc.items, ...bcc.items].map((a) => a.address.trim().toLowerCase());
    return [...new Set(all)].filter((a) => a.includes("@"));
  }, [to, cc, bcc]);
  const blockedQ = useQuery({
    queryKey: ["blocklist-check", recipientAddrs],
    queryFn: () =>
      api<{ blocked: string[] }>("/api/blocklist/check", {
        method: "POST",
        body: JSON.stringify({ addresses: recipientAddrs }),
      }),
    enabled: recipientAddrs.length > 0,
    staleTime: 30_000,
  });
  const blockedRecipients = recipientAddrs.length ? (blockedQ.data?.blocked ?? []) : [];

  // Close the dock, or close the OS window when running as a pop-out.
  function finish() {
    if (isWindow) window.close();
    else closeCompose();
  }

  function discard() {
    void deleteDraft().catch(() => {});
    // Suppress the close-flush so unmount doesn't re-create the discarded draft.
    latestRef.current = null;
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
  function passesSendGuards(): boolean {
    const composed = mode === "html" ? htmlToText(html) : text;
    if (attachments.length === 0 && uploading === 0 && mentionsAttachment(composed)) {
      const ok = window.confirm(
        "It looks like you mentioned an attachment, but nothing is attached.\n\nSend anyway?",
      );
      if (!ok) return false;
    }
    if (blockedRecipients.length > 0) {
      const ok = window.confirm(
        `You've blocked ${blockedRecipients.join(", ")}. They can't reach this server, so you won't receive any reply.\n\nSend anyway?`,
      );
      if (!ok) return false;
    }
    return true;
  }

  function attemptSend() {
    if (passesSendGuards()) send.mutate();
  }

  // Schedule the send for `when`, applying the same pre-send guards.
  function scheduleSend(when: Date) {
    if (Number.isNaN(when.getTime())) {
      toast.error("Pick a valid date and time");
      return;
    }
    if (when.getTime() < Date.now() + 60_000) {
      toast.error("Pick a time at least a minute from now");
      return;
    }
    if (!passesSendGuards()) return;
    setScheduleOpen(false);
    schedule.mutate(when.getTime());
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

  // Insert a saved template at the caret. Placeholders are resolved from the
  // current recipient/sender; an unfilled subject is taken from the template.
  function insertTemplate(t: { subject?: string; body: string }) {
    const r = to.items[0];
    const ctx: TemplateContext = {
      recipientName: r?.name,
      recipientEmail: r?.address,
      myName: meData?.user?.name,
      myEmail: currentFrom,
    };
    const body = fillTemplate(t.body, ctx);
    if (t.subject && !subject.trim()) setSubject(fillTemplate(t.subject, ctx));
    if (mode === "html") {
      editorRef.current?.insertHtml(textToHtml(body));
    } else {
      const ta = bodyTextareaRef.current;
      const start = ta?.selectionStart ?? text.length;
      const end = ta?.selectionEnd ?? text.length;
      setText(text.slice(0, start) + body + text.slice(end));
      requestAnimationFrame(() => {
        const caret = start + body.length;
        ta?.focus();
        ta?.setSelectionRange(caret, caret);
      });
    }
    setTemplatesOpen(false);
  }

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
      const up = await api<UploadedAttachment>("/api/attachments/upload", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-filename": encodeURIComponent(file.name),
        },
        body: await file.arrayBuffer(),
      });
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
    if (mode === "html") {
      editorRef.current?.insertHtml(imgHtml);
    } else {
      setHtml(`${textToHtml(text)}${imgHtml}`);
      pendingCmdRef.current = null;
      setMode("html");
    }
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────
  function onDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
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
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-primary border-dashed px-8 py-6 text-primary">
            <Paperclip className="size-7" />
            <span className="font-medium text-[13px]">Drop files to attach</span>
          </div>
        </div>
      )}
      <ImageChoiceDialog
        open={pendingImages.length > 0}
        onOpenChange={(next) => {
          if (!next) setPendingImages([]);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {pendingImages.length > 1 ? `Add ${pendingImages.length} images` : "Add image"}
            </DialogTitle>
            <DialogDescription>
              Embed {pendingImages.length > 1 ? "them" : "it"} in the message or attach as
              {pendingImages.length > 1 ? " files" : " a file"}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <ToggleGroup
              value={placement}
              onValueChange={(v) => setPlacement(v)}
              className="w-full [&>*]:flex-1"
            >
              <ToggleItem value="inline">
                <ImageIcon />
                In message
              </ToggleItem>
              <ToggleItem value="attachment">
                <Paperclip />
                As attachment
              </ToggleItem>
            </ToggleGroup>
            <Label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <Checkbox checked={stripMeta} onCheckedChange={(v) => setStripMeta(v === true)} />
              Remove image metadata (EXIF, GPS)
            </Label>
            {pendingImages.some((f) => canDownscale(f.type)) && (
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span>Scale down</span>
                <Select
                  items={[
                    { value: "0", label: "Original size" },
                    { value: "2048", label: "Large (2048px)" },
                    { value: "1280", label: "Medium (1280px)" },
                    { value: "640", label: "Small (640px)" },
                  ]}
                  value={String(resizeMax)}
                  onValueChange={(v) => setResizeMax(Number(v))}
                >
                  <SelectTrigger className="h-8 w-36 text-[13px]" aria-label="Scale down image">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Original size</SelectItem>
                    <SelectItem value="2048">Large (2048px)</SelectItem>
                    <SelectItem value="1280">Medium (1280px)</SelectItem>
                    <SelectItem value="640">Small (640px)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingImages([])}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void commitPendingImages()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </ImageChoiceDialog>
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
          <Select
            value={currentFrom}
            onValueChange={(v) => {
              const opt = fromOptions.find((o) => o.address === v);
              if (!opt) return;
              setMailboxId(opt.mailboxId);
              // Track an override only for a plus-alias; a base address is null.
              setFromAddress(
                opt.address.toLowerCase() === baseAddr(opt.mailboxId).toLowerCase()
                  ? null
                  : opt.address,
              );
            }}
          >
            <SelectTrigger
              aria-label="From address"
              className="h-auto w-auto flex-1 justify-between gap-1 border-0 bg-transparent px-0 py-0.5 text-left text-[13px] leading-5 shadow-none hover:bg-transparent focus-visible:ring-0"
            >
              <SelectValue>{(value) => (value as string) ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {fromOptions.map((o) => (
                <SelectItem key={o.address} value={o.address}>
                  {o.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover
            open={plusOpen}
            onOpenChange={(open) => {
              setPlusOpen(open);
              if (open) {
                const local = plusBase(currentFrom);
                setPlusTag(
                  local && currentFrom.toLowerCase() !== local
                    ? (currentFrom.slice(currentFrom.indexOf("+") + 1).split("@")[0] ?? "")
                    : "",
                );
              }
            }}
          >
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Custom sub-address"
                  className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              }
            />
            <PopoverContent side="bottom" align="start" className="w-72 p-2">
              <span className="mb-1.5 block px-0.5 text-[11px] text-muted-foreground">
                Custom sub-address
              </span>
              {(() => {
                const base = baseAddr(mailboxId);
                const at = base.lastIndexOf("@");
                const local = at > 0 ? base.slice(0, at) : base;
                const domain = at > 0 ? base.slice(at + 1) : "";
                return (
                  <div className="flex items-center rounded-md border bg-card px-2 text-[13px] focus-within:ring-2 focus-within:ring-ring/40">
                    <span className="shrink-0 text-muted-foreground">{local}+</span>
                    <input
                      // biome-ignore lint/a11y/noAutofocus: focus the field when the picker opens
                      autoFocus
                      value={plusTag}
                      onChange={(e) => setPlusTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          applyPlusTag();
                        }
                      }}
                      placeholder="tag"
                      className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted-foreground"
                    />
                    <span className="shrink-0 text-muted-foreground">@{domain}</span>
                  </div>
                );
              })()}
              <Button variant="primary" size="sm" className="mt-2 w-full" onClick={applyPlusTag}>
                Use address
              </Button>
            </PopoverContent>
          </Popover>
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
        {blockedRecipients.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {blockedRecipients.length === 1
                ? `${blockedRecipients[0]} is on your blocklist`
                : `${blockedRecipients.join(", ")} are on your blocklist`}{" "}
              — they can't reach this server, so you won't receive any reply.
            </span>
          </div>
        )}
        <label className={FIELD_ROW}>
          <span className={FIELD_LABEL}>Sub</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => {
              // Skip the format toolbar — Tab from Subject lands in the body.
              if (e.key !== "Tab" || e.shiftKey) return;
              const body = mode === "html" ? editorRef.current : bodyTextareaRef.current;
              if (!body) return;
              e.preventDefault();
              body.focus();
            }}
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
            ref={bodyTextareaRef}
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
        {attachments.some((a) => !a.inline) && (
          <ul className="flex flex-wrap gap-1.5 border-t pt-2">
            {attachments
              .filter((a) => !a.inline)
              .map((a) => (
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
                    onClick={() =>
                      setAttachments((prev) => prev.filter((x) => x.r2Key !== a.r2Key))
                    }
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
          <div className="flex items-center">
            <Button
              variant="primary"
              onClick={attemptSend}
              disabled={
                send.isPending ||
                schedule.isPending ||
                uploading > 0 ||
                !mailboxId ||
                !hasRecipients(to)
              }
              className="rounded-r-none"
            >
              {send.isPending ? "Sending…" : "Send"}
            </Button>
            <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="primary"
                    size="icon"
                    aria-label="Schedule send"
                    disabled={
                      send.isPending ||
                      schedule.isPending ||
                      uploading > 0 ||
                      !mailboxId ||
                      !hasRecipients(to)
                    }
                    className="ml-px w-7 rounded-l-none border-primary-foreground/20 border-l"
                  >
                    <ChevronDown />
                  </Button>
                }
              />
              <PopoverContent side="top" align="start" className="w-64 p-1.5">
                <div className="px-1.5 py-1 font-medium text-[11px] text-muted-foreground">
                  Schedule send
                </div>
                {schedulePresets().map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => scheduleSend(p.when)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
                  >
                    <span>{p.label}</span>
                    <span className="text-[11px] text-muted-foreground">{formatWhen(p.when)}</span>
                  </button>
                ))}
                <div className="my-1 h-px bg-border" />
                <div className="px-0.5 pt-0.5 pb-1">
                  <span className="mb-1 block px-1 text-[11px] text-muted-foreground">
                    Custom date &amp; time
                  </span>
                  <Calendar
                    mode="single"
                    selected={customDate}
                    onSelect={setCustomDate}
                    disabled={{ before: new Date() }}
                    className="p-0"
                  />
                  <div className="mt-1 flex items-center gap-2 px-1">
                    <Clock className="size-3.5 text-muted-foreground" />
                    <input
                      type="time"
                      value={customTime}
                      onChange={(e) => setCustomTime(e.target.value)}
                      className="flex-1 rounded-md border bg-card px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    className="mt-2 w-full"
                    disabled={!customDate || schedule.isPending}
                    onClick={() =>
                      customDate && scheduleSend(combineDateTime(customDate, customTime))
                    }
                  >
                    Schedule
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
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
              void handleIncomingFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <Popover open={templatesOpen} onOpenChange={setTemplatesOpen}>
            <PopoverTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="Insert template">
                  <FileText />
                </Button>
              }
            />
            <PopoverContent side="top" align="start" className="w-64 p-1.5">
              <div className="px-1.5 py-1 font-medium text-[11px] text-muted-foreground">
                Insert template
              </div>
              {templates.length === 0 ? (
                <p className="px-1.5 py-1.5 text-[12px] text-muted-foreground">
                  No templates yet. Add them in Settings → Templates.
                </p>
              ) : (
                templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => insertTemplate(t)}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
                    title={t.name}
                  >
                    {t.name}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex items-center gap-2">
          {pgpMode !== "off" && (
            <span className="text-[11px] font-medium text-primary">
              {pgpMode === "sign_encrypt" ? "Will encrypt + sign" : "Will sign"}
            </span>
          )}
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
        onPaste={onPaste}
        {...dragHandlers}
        className="relative flex h-dvh flex-col overflow-hidden bg-card text-card-foreground"
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
          onPaste={onPaste}
          {...dragHandlers}
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

// The base mailbox address an address belongs to, stripping any "+tag"
// sub-address. Returns lowercase "<base>@<domain>", or null if not an address.
function plusBase(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const local = addr.slice(0, at).split("+")[0] ?? "";
  return `${local}@${addr.slice(at + 1)}`.toLowerCase();
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
