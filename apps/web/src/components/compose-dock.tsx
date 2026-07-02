import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ExternalLink,
  Lock,
  Maximize2,
  Minimize2,
  Paperclip,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import { contactsQuery, mailboxesQuery, meQuery, messageBodyQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { fillTemplate, type TemplateContext } from "@/lib/templates.ts";
import {
  AddressField,
  collectRecipients,
  hasRecipients,
  type RecipientsValue,
} from "./address-field.tsx";
import { AttachmentList } from "./compose/attachment-list.tsx";
import {
  type ComposeState,
  closeCompose,
  registerComposeQueryClient,
  useComposeState,
} from "./compose/compose-store.ts";
import {
  type BodyFormat,
  MAX_ATTACHMENTS,
  mentionsAttachment,
  prefixSubject,
  resolveInlineImages,
  uniqueRecipients,
} from "./compose/compose-utils.ts";
import { FollowUpPopover, TemplatesPopover } from "./compose/footer-popovers.tsx";
import { FromField } from "./compose/from-field.tsx";
import { ImageChoiceDialog } from "./compose/image-choice-dialog.tsx";
import { loadMarkdownLibs, useMarkdownLibs } from "./compose/markdown-libs.ts";
import { SchedulePopover } from "./compose/schedule-popover.tsx";
import { useAttachments } from "./compose/use-attachments.ts";
import { type DraftSnapshot, useDraftPersistence } from "./compose/use-draft-persistence.ts";
import { useFromAddress } from "./compose/use-from-address.ts";
import { EmailFrame } from "./email-frame.tsx";
import {
  FormatToolbar,
  htmlToText,
  type PendingCmd,
  RichEditor,
  type RichEditorHandle,
  textToHtml,
} from "./rich-editor.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { ButtonGroup } from "./ui/button-group.tsx";
import { Field, FieldContent, FieldGroup, FieldLabel } from "./ui/field.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Textarea } from "./ui/textarea.tsx";

export type { ComposeState } from "./compose/compose-store.ts";
export { openCompose } from "./compose/compose-store.ts";

export function ComposeDock() {
  const qc = useQueryClient();
  // Let the module-level openCompose() read compose prefs from the Query cache.
  useEffect(() => {
    registerComposeQueryClient(qc);
  }, [qc]);
  const s = useComposeState();
  if (!s.open) return null;
  // Remount when the target changes so the form re-initializes cleanly.
  return (
    <ComposeForm
      key={s.draft?.id ?? s.replyToMessage?.id ?? s.forwardMessage?.id ?? "new"}
      state={s}
    />
  );
}

// Inline value text for a Field's control (From/Subject), aligned to the label
// baseline and growing only on wrap. Shared by the <Field> rows below.
const FIELD_INPUT =
  "w-full bg-transparent py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground";

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
  // eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity feeds `flush`'s deps (autosave), which exhaustive-deps requires
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
  const selfAddrs = (() => {
    const set = new Set<string>();
    const mbAddr = (mailboxes?.mailboxes ?? [])
      .find((m) => m.id === rep?.mailboxId)
      ?.address?.toLowerCase();
    if (mbAddr) set.add(mbAddr);
    if (rep?.deliveredTo) set.add(rep.deliveredTo.toLowerCase());
    return set;
  })();

  const from = useFromAddress({ draft: d, replyTo: rep, forward: fwd, sendable });
  const { mailboxId, fromAddress, currentFrom } = from;
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

  // Attachment intake; inline images land in the HTML body, promoting a
  // plain-text draft to rich when needed.
  const attach = useAttachments({
    initial: d?.attachments ?? [],
    embedInlineHtml: (imgHtml) => {
      if (mode === "html") {
        editorRef.current?.insertHtml(imgHtml);
      } else {
        setHtml(`${textToHtml(text)}${imgHtml}`);
        pendingCmdRef.current = null;
        setMode("html");
      }
    },
  });
  const { attachments, uploading } = attach;

  // The original body, fetched for the quoted-message preview. The server
  // re-quotes from the raw `.eml` at send time (mail/quote.ts); this is only so
  // the composer can show what's being included.
  const { data: origBodyData } = useQuery({
    ...messageBodyQuery(quoteRef?.messageId ?? ""),
    enabled: Boolean(quoteRef),
  });
  // sanitize-email pulls in DOMPurify; loaded on demand (only a reply/forward
  // has a quoted body to sanitize) so it stays out of the first-paint chunk.
  const [quotedHtml, setQuotedHtml] = useState<string | null>(null);
  useEffect(() => {
    const raw = origBodyData?.html;
    if (!raw) {
      // react-doctor-disable-next-line no-adjust-state-on-prop-change -- quoted body is sanitized via a dynamic DOMPurify import; can't derive during render
      setQuotedHtml(null);
      return;
    }
    let cancelled = false;
    void import("@/lib/sanitize-email.ts").then(({ sanitizeEmailHtml }) => {
      if (!cancelled) setQuotedHtml(sanitizeEmailHtml(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [origBodyData?.html]);
  const [preview, setPreview] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // "Remind me if no reply" — off until the user opts in; days is the window.
  const [followUp, setFollowUp] = useState(false);
  const [followUpDays, setFollowUpDays] = useState(3);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Threading context: a reopened draft carries it; a fresh reply derives it
  // from the message being answered.
  const inReplyTo = d?.inReplyTo ?? rep?.messageIdHdr ?? undefined;
  const references =
    d?.references ??
    (rep
      ? [...(rep.references ?? []), rep.messageIdHdr].filter((x): x is string => Boolean(x))
      : undefined);

  // The current form state as a draft snapshot + whether it's effectively blank.
  // eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity feeds the debounced-autosave effect's exhaustive-deps
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

  const { savedHint, invalidateDrafts, deleteDraft, ensureDraftSaved, suppressCloseFlush } =
    useDraftPersistence({
      initialDraftId: d?.id ?? null,
      mailboxId,
      inReplyTo,
      references,
      quoteRef,
      currentSnapshot,
    });

  const mdLibs = useMarkdownLibs();

  const previewHtml = (() => {
    if (mode !== "markdown" || !text.trim() || !mdLibs) return "";
    const rendered = mdLibs.marked.parse(text, { async: false }) as string;
    return mdLibs.DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  })();

  // Resolve the editor state into the wire body: plain text → text only;
  // markdown → text source + rendered html; rich → sanitized html plus a derived
  // text alternative for non-HTML clients. Shared by immediate + scheduled send.
  const buildBody = async (): Promise<{
    text: string | undefined;
    html: string | undefined;
  }> => {
    if (mode === "html") {
      const { html: resolved } = resolveInlineImages(html);
      if (!resolved.trim()) return { html: undefined, text: undefined };
      const { DOMPurify } = await loadMarkdownLibs();
      const htmlBody = DOMPurify.sanitize(resolved, { USE_PROFILES: { html: true } });
      return { html: htmlBody, text: htmlToText(html) || undefined };
    }
    if (mode === "markdown") {
      if (!text.trim()) return { text, html: undefined };
      const { marked, DOMPurify } = await loadMarkdownLibs();
      const rendered = marked.parse(text, { async: false }) as string;
      return { text, html: DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } }) };
    }
    return { text, html: undefined };
  };

  // The full outbound payload — identical whether the send fires now or later.
  const buildSendPayload = async () => {
    const body = await buildBody();
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
      followUpDays: followUp ? followUpDays : undefined,
    };
  };

  const send = useMutation({
    mutationFn: async () => unwrap(rpc.messages.send.$post({ json: await buildSendPayload() })),
    onSuccess: async (res) => {
      if (res?.pgpWarning) toast.warning(res.pgpWarning);
      else toast.success("Message sent");
      if (mailboxId) qc.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
      // Keep the combined "All" view's lists/counts in sync with the send.
      qc.invalidateQueries({ queryKey: keys.threadsRoot("all") });
      await deleteDraft().catch(() => {});
      // The message is sent and the draft removed — don't let the close-flush
      // resurrect it on unmount.
      suppressCloseFlush();
      finish();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  // Defer the send: persist the draft, then hand the server the resolved payload
  // + target time. The draft becomes the scheduled record (visible/cancelable in
  // Drafts) rather than being deleted.
  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess calls invalidateDrafts() (qc.invalidateQueries) already
  const schedule = useMutation({
    mutationFn: async (sendAt: number) => {
      const id = await ensureDraftSaved();
      if (!id) throw new Error("Nothing to schedule");
      return unwrap(
        rpc.drafts[":id"].schedule.$post({
          param: { id },
          json: { sendAt, payload: await buildSendPayload() },
        }),
      );
    },
    onSuccess: (_res, sendAt) => {
      toast.success(`Send scheduled for ${new Date(sendAt).toLocaleString()}`);
      invalidateDrafts();
      // The draft now holds the scheduled payload — suppress the close-flush so
      // unmount doesn't PATCH a stale edit over it.
      suppressCloseFlush();
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
  const recipientAddrs = (() => {
    const all = [...to.items, ...cc.items, ...bcc.items].map((a) => a.address.trim().toLowerCase());
    return [...new Set(all)].filter((a) => a.includes("@"));
  })();
  const { data: blockedData } = useQuery({
    queryKey: ["blocklist-check", recipientAddrs],
    queryFn: () => unwrap(rpc.blocklist.check.$post({ json: { addresses: recipientAddrs } })),
    enabled: recipientAddrs.length > 0,
    staleTime: 30_000,
  });
  const blockedRecipients = recipientAddrs.length ? (blockedData?.blocked ?? []) : [];

  // Close the dock, or close the OS window when running as a pop-out.
  function finish() {
    if (isWindow) window.close();
    else closeCompose();
  }

  function discard() {
    void deleteDraft().catch(() => {});
    // Suppress the close-flush so unmount doesn't re-create the discarded draft.
    suppressCloseFlush();
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
      {attach.dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-primary border-dashed px-8 py-6 text-primary">
            <Paperclip className="size-7" />
            <span className="font-medium text-[13px]">Drop files to attach</span>
          </div>
        </div>
      )}
      <ImageChoiceDialog attach={attach} />
      <div className="flex items-center justify-between gap-2 border-b bg-muted/60 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              pgpMode === "sign_encrypt"
                ? "bg-primary"
                : pgpMode === "sign"
                  ? "bg-primary/60"
                  : "bg-muted-foreground/40",
            )}
          />
          {isWindow ? (
            <span className="truncate font-semibold text-[13px] text-foreground tracking-tight">
              {titleText}
            </span>
          ) : (
            <Dialog.Title className="truncate font-semibold text-[13px] text-foreground tracking-tight">
              {titleText}
            </Dialog.Title>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {!isWindow && (
            <>
              <IconButton
                label="Open in new window"
                icon={ExternalLink}
                size="icon-sm"
                onClick={popOut}
                className="hidden sm:inline-flex"
              />
              <IconButton
                label={expanded ? "Shrink" : "Expand"}
                icon={expanded ? Minimize2 : Maximize2}
                size="icon-sm"
                onClick={() => setExpanded((v) => !v)}
                className="hidden sm:inline-flex"
              />
            </>
          )}
          {isWindow ? (
            <IconButton label="Close" icon={X} size="icon-sm" onClick={() => window.close()} />
          ) : (
            <Dialog.Close
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
              aria-label="Close"
            >
              <X className="size-3.5" />
            </Dialog.Close>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-1">
        <FieldGroup>
          <FromField from={from} />
          <AddressField
            label="To"
            value={to}
            onChange={setTo}
            placeholder="name@example.com"
            contacts={contacts}
            trailing={
              !showCc && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCc(true)}
                  className="mt-px h-6 px-1.5 text-[11px]"
                >
                  Cc/Bcc
                </Button>
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
            <div className="my-1.5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {blockedRecipients.length === 1
                  ? `${blockedRecipients[0]} is on your blocklist`
                  : `${blockedRecipients.join(", ")} are on your blocklist`}{" "}
                — they can't reach this server, so you won't receive any reply.
              </span>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="compose-subject">Subject</FieldLabel>
            <FieldContent>
              <input
                id="compose-subject"
                aria-label="Subject"
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
                placeholder="Subject"
                className={FIELD_INPUT}
              />
            </FieldContent>
          </Field>
        </FieldGroup>
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
            dangerouslySetInnerHTML={{ __html: previewHtml }} // react-doctor-disable-line dangerous-html-sink -- previewHtml is DOMPurify.sanitize() output
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
        <AttachmentList
          attachments={attachments}
          onRemove={(r2Key) =>
            attach.setAttachments((prev) => prev.filter((x) => x.r2Key !== r2Key))
          }
        />
        {quoteRef && (
          <div className="mt-2 border-t pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowQuote((v) => !v)}
              className="h-6 px-1.5 text-[11px]"
            >
              {showQuote ? "Hide" : "Show"} quoted message
            </Button>
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
                    {origBodyData?.text ?? rep?.snippet ?? fwd?.snippet ?? ""}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-2">
        <div className="flex items-center gap-1">
          <ButtonGroup>
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
            >
              {send.isPending ? <Spinner /> : <Send />}
              {send.isPending ? "Sending…" : "Send"}
            </Button>
            <SchedulePopover
              open={scheduleOpen}
              onOpenChange={setScheduleOpen}
              disabled={
                send.isPending ||
                schedule.isPending ||
                uploading > 0 ||
                !mailboxId ||
                !hasRecipients(to)
              }
              pending={schedule.isPending}
              onSchedule={scheduleSend}
            />
          </ButtonGroup>
          <IconButton
            label="Attach files"
            icon={Paperclip}
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label="Attach files"
            className="hidden"
            onChange={(e) => {
              void attach.handleIncomingFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <TemplatesPopover templates={templates} onInsert={insertTemplate} />
          <FollowUpPopover
            followUp={followUp}
            onFollowUpChange={setFollowUp}
            days={followUpDays}
            onDaysChange={setFollowUpDays}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {pgpMode !== "off" && (
            <Badge variant="primary" className="shrink-0">
              {pgpMode === "sign_encrypt" ? (
                <Lock className="size-3" />
              ) : (
                <ShieldCheck className="size-3" />
              )}
              {pgpMode === "sign_encrypt" ? "Encrypt + sign" : "Sign"}
            </Badge>
          )}
          <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            {uploading > 0 ? (
              <>
                <Spinner className="size-3" />
                Uploading {uploading}…
              </>
            ) : sendable.length === 0 ? (
              "No sendable mailboxes"
            ) : savedHint ? (
              "Draft saved"
            ) : null}
          </span>
          <IconButton
            label="Discard draft"
            icon={Trash2}
            onClick={discard}
            className="hover:bg-destructive/10 hover:text-destructive"
          />
        </div>
      </div>
    </>
  );

  if (isWindow) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: container-level ⌘/Ctrl+Enter send shortcut; inner fields stay the focus targets
      <div // react-doctor-disable-line no-static-element-interactions -- container-level keyboard shortcut wrapper; focus stays on inner fields
        onKeyDown={onContainerKeyDown}
        onPaste={attach.onPaste}
        {...attach.dragHandlers}
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
          onPaste={attach.onPaste}
          {...attach.dragHandlers}
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
