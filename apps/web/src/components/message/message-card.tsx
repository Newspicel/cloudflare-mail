import { Flag, hasFlag } from "@cfmail/shared/flags";
import type { AttachmentDto } from "@cfmail/shared/responses";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  Ellipsis,
  FileText,
  Forward,
  Image,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldCheck,
  Star,
} from "lucide-react";
import { useState } from "react";
import { CodeBanner } from "@/components/code-banner.tsx";
import { openCompose } from "@/components/compose-dock.tsx";
import { EmailFrame } from "@/components/email-frame.tsx";
import { LabelChips } from "@/components/labels-menu.tsx";
import { MessageMenu } from "@/components/message-menu.tsx";
import { SenderAvatar } from "@/components/sender-avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tooltip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { linkifyText } from "@/lib/linkify.tsx";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import type { MessageRow } from "@/lib/queries.ts";
import { messageBodyQuery } from "@/lib/queries.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { splitQuotedHtml, splitQuotedText, stripQuotedSnippet } from "@/lib/split-quote.ts";
import { formatDateTime } from "@/lib/time.ts";
import { AttachmentPreview, attachmentUrl, isPreviewable } from "./attachment-preview.tsx";
import { PgpBanner, SpamBanner, UnsubscribeBanner } from "./banners.tsx";
import { CalendarBanner } from "./calendar-banner.tsx";
import { SenderLock } from "./sender-lock.tsx";

function addrList(list: { name?: string; address: string }[]): string {
  return list.map((a) => a.name ?? a.address).join(", ");
}

// Reply / reply-all / forward, grouped as a single segmented control.
function MessageActions({ msg }: { msg: MessageRow }) {
  return (
    <div className="flex items-center overflow-hidden rounded-lg border bg-background shadow-black/[0.03] shadow-sm">
      <ActionIcon label="Reply" onClick={() => openCompose({ replyToMessage: msg })}>
        <Reply />
      </ActionIcon>
      <span className="h-5 w-px bg-border" />
      <ActionIcon
        label="Reply all"
        onClick={() => openCompose({ replyToMessage: msg, replyAll: true })}
      >
        <ReplyAll />
      </ActionIcon>
      <span className="h-5 w-px bg-border" />
      <ActionIcon label="Forward" onClick={() => openCompose({ forwardMessage: msg })}>
        <Forward />
      </ActionIcon>
    </div>
  );
}

function ActionIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="grid size-8 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none [&_svg]:size-4"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Real (non-inline) attachments, shown below the body. Images and PDFs open in
// the in-app viewer; anything else is download-only. Inline `cid:` parts are
// embedded in the HTML and rewritten by the body endpoint, so they're filtered
// out here to avoid duplicating them.
function MessageAttachments({
  messageId,
  attachments,
  hasHtml,
}: {
  messageId: string;
  attachments: AttachmentDto[];
  hasHtml: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const visible = attachments.filter((a) => !(hasHtml && a.inline && a.contentId));
  if (visible.length === 0) return null;
  const chip =
    "flex min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted";
  return (
    <div className="flex flex-wrap gap-2 border-t bg-muted/30 px-4 py-3">
      {visible.map((att) => {
        const viewable = isPreviewable(att.contentType);
        const Icon = viewable
          ? att.contentType.startsWith("image/")
            ? Image
            : FileText
          : Paperclip;
        const label = (
          <>
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-[12px]">{att.filename}</span>
              <span className="block text-[11px] text-muted-foreground">
                {formatBytes(att.sizeBytes)}
              </span>
            </span>
          </>
        );
        return (
          <div
            key={att.id}
            className="group flex max-w-full items-stretch overflow-hidden rounded-lg border bg-background shadow-black/[0.02] shadow-sm transition-colors hover:border-primary/40"
          >
            {viewable ? (
              <button type="button" onClick={() => setPreview(att.id)} className={chip}>
                {label}
              </button>
            ) : (
              <a
                href={attachmentUrl(messageId, att.id, true)}
                download={att.filename}
                className={chip}
              >
                {label}
              </a>
            )}
            <a
              href={attachmentUrl(messageId, att.id, true)}
              download={att.filename}
              aria-label={`Download ${att.filename}`}
              className="grid shrink-0 place-items-center border-l px-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="size-4" />
            </a>
          </div>
        );
      })}
      <AttachmentPreview
        messageId={messageId}
        attachments={visible}
        openId={preview}
        onOpenChange={setPreview}
      />
    </div>
  );
}

export function messageTime(msg: MessageRow): Date {
  return new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt);
}

// A folded message: one line of who, what and when. Clicking opens it.
export function CollapsedMessage({
  msg,
  cardRef,
  onExpand,
}: {
  msg: MessageRow;
  cardRef?: React.Ref<HTMLElement>;
  onExpand: () => void;
}) {
  const fmt = useDateTimeFmt();
  const unread = msg.direction === "in" && !hasFlag(msg.flags, Flag.SEEN);
  const when = messageTime(msg);
  return (
    <article
      ref={cardRef}
      data-message-id={msg.id}
      className="overflow-hidden rounded-lg border bg-card shadow-black/[0.02] shadow-sm"
    >
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      >
        <SenderAvatar name={msg.fromName ?? undefined} address={msg.fromAddr} size={24} />
        <span
          className={cn(
            "w-40 shrink-0 truncate text-[13px]",
            unread ? "font-semibold" : "font-medium",
          )}
        >
          {msg.direction === "out" ? "You" : (msg.fromName ?? msg.fromAddr)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {stripQuotedSnippet(msg.snippet)}
        </span>
        {hasFlag(msg.flags, Flag.STARRED) && (
          <Star className="size-3.5 shrink-0 fill-current text-amber-500" aria-label="Starred" />
        )}
        <time
          className="shrink-0 text-[11px] text-muted-foreground"
          title={when.toLocaleString(undefined, { hour12: fmt.hour12 })}
        >
          {formatDateTime(when, fmt)}
        </time>
      </button>
    </article>
  );
}

// "•••" under a reply whose quoted history is folded away.
function QuoteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="px-4 pb-3">
      <Tooltip label={open ? "Hide quoted text" : "Show quoted text"}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onToggle}
          aria-label={open ? "Hide quoted text" : "Show quoted text"}
          aria-expanded={open}
          className="h-5 px-1.5"
        >
          <Ellipsis />
        </Button>
      </Tooltip>
    </div>
  );
}

export function MessageCard({
  msg,
  cardRef,
  readOnly,
  highlight,
  onCollapse,
  onTrash,
  onRestore,
  onDelete,
  busy,
  onToggleStar,
}: {
  msg: MessageRow;
  cardRef?: React.Ref<HTMLElement>;
  readOnly: boolean;
  /** The message a link pointed at (e.g. a search hit). */
  highlight?: boolean;
  /** Folds the card back to a one-line summary; clicking the header calls it. */
  onCollapse?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  busy?: boolean;
  onToggleStar: () => void;
}) {
  // The body isn't in the thread payload (listing only carries the snippet);
  // fetch the full parsed body lazily when the card mounts.
  const { data: bodyData, isPending: bodyPending } = useQuery(messageBodyQuery(msg.id));
  const fmt = useDateTimeFmt();
  const [showQuote, setShowQuote] = useState(false);
  const bodyHtml = bodyData?.html ? sanitizeEmailHtml(bodyData.html) : null;
  const bodyText = bodyData?.text ?? msg.snippet;
  // Earlier messages already have their own cards, so a reply's quoted
  // history is folded behind "•••" rather than repeated.
  const split = bodyHtml ? splitQuotedHtml(bodyHtml) : splitQuotedText(bodyText);
  const folded = split.quote !== null && !showQuote;
  const starred = hasFlag(msg.flags, Flag.STARRED);
  const when = messageTime(msg);

  // Clicks on the header's controls (buttons, links, menus) keep the card open.
  function onHeaderClick(e: React.MouseEvent) {
    if (!onCollapse) return;
    if ((e.target as Element).closest("button, a, [role='menu'], [role='menuitem']")) return;
    if (window.getSelection()?.toString()) return;
    onCollapse();
  }

  return (
    <article
      ref={cardRef}
      data-message-id={msg.id}
      className={cn(
        "overflow-hidden rounded-lg border bg-card shadow-black/[0.02] shadow-sm",
        highlight && "ring-2 ring-primary/40",
      )}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse shortcut; the header's controls and "Collapse all" cover the keyboard */}
      <header
        onClick={onHeaderClick}
        className={cn(
          "flex items-start justify-between gap-4 border-b px-4 py-2.5",
          onCollapse && "cursor-pointer",
        )}
      >
        <SenderAvatar name={msg.fromName ?? undefined} address={msg.fromAddr} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-[13px]">
            <SenderLock msg={msg} />
            <span className="truncate">
              {msg.fromName ?? msg.fromAddr}{" "}
              <span className="font-normal text-muted-foreground">&lt;{msg.fromAddr}&gt;</span>
            </span>
          </div>
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <div>
              <span className="text-muted-foreground/70">to</span> {addrList(msg.toAddrs)}
            </div>
            {msg.ccAddrs && msg.ccAddrs.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">cc</span> {addrList(msg.ccAddrs)}
              </div>
            )}
            {msg.bccAddrs && msg.bccAddrs.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">bcc</span> {addrList(msg.bccAddrs)}
              </div>
            )}
          </div>
          <LabelChips messageId={msg.id} className="mt-1.5" />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            {bodyData && bodyData.trackersBlocked > 0 && (
              <Tooltip
                label={`${bodyData.trackersBlocked} tracking ${bodyData.trackersBlocked === 1 ? "pixel" : "pixels"} blocked`}
              >
                <Badge variant="outline" className="gap-1 px-1.5 text-[11px] text-muted-foreground">
                  <ShieldCheck className="size-3" aria-hidden />
                  {bodyData.trackersBlocked}
                  <span className="sr-only">tracking pixels blocked</span>
                </Badge>
              </Tooltip>
            )}
            <time
              className="text-[11px] text-muted-foreground"
              title={when.toLocaleString(undefined, { hour12: fmt.hour12 })}
            >
              {formatDateTime(when, fmt)}
            </time>
            {!readOnly && (
              <Tooltip label={starred ? "Unstar" : "Star"}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onToggleStar}
                  className={cn(starred && "text-amber-500 hover:text-amber-500")}
                  aria-label={starred ? "Unstar" : "Star"}
                  aria-pressed={starred}
                >
                  <Star className={cn(starred && "fill-current")} />
                </Button>
              </Tooltip>
            )}
            <MessageMenu
              msg={msg}
              body={bodyData}
              onTrash={onTrash}
              onRestore={onRestore}
              onDelete={onDelete}
              busy={busy}
            />
          </div>
          {!readOnly && <MessageActions msg={msg} />}
        </div>
      </header>
      <SpamBanner msg={msg} />
      <CodeBanner
        from={msg.fromAddr}
        subject={msg.subject}
        text={bodyData?.text}
        html={bodyData?.html}
        direction={msg.direction}
        otpCode={msg.otpCode}
        otpOrigin={msg.otpOrigin}
      />
      <PgpBanner msg={msg} readOnly={readOnly} />
      <UnsubscribeBanner msg={msg} readOnly={readOnly} />
      {bodyData?.calendar && <CalendarBanner event={bodyData.calendar} />}
      {bodyPending ? (
        // Hold the space with a skeleton while the body loads. Rendering the
        // snippet here flashed a plain-text preview that then got replaced by the
        // HTML frame — the "text first, then HTML" lag.
        <div className="space-y-2 px-4 py-3" aria-hidden>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
      ) : bodyHtml ? (
        // Untrusted HTML renders in a sandboxed, scriptless iframe so a
        // sanitizer bypass can't reach the app origin or the session.
        <EmailFrame html={folded ? split.main : bodyHtml} />
      ) : (
        // Plain-text body once loaded (or the snippet if parsing yields neither).
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] px-4 py-3 font-sans text-[13px]">
          {linkifyText(folded ? split.main : bodyText)}
        </pre>
      )}
      {!bodyPending && split.quote !== null && (
        <QuoteToggle open={showQuote} onToggle={() => setShowQuote((v) => !v)} />
      )}
      {bodyData?.attachments && bodyData.attachments.length > 0 && (
        <MessageAttachments
          messageId={msg.id}
          attachments={bodyData.attachments}
          hasHtml={Boolean(bodyHtml)}
        />
      )}
    </article>
  );
}
