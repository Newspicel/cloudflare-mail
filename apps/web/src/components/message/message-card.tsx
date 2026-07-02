import { Flag, hasFlag } from "@cfmail/shared/flags";
import type { AttachmentDto } from "@cfmail/shared/responses";
import { useQuery } from "@tanstack/react-query";
import { Download, Forward, Paperclip, Reply, ReplyAll, Star } from "lucide-react";
import { CodeBanner } from "@/components/code-banner.tsx";
import { openCompose } from "@/components/compose-dock.tsx";
import { EmailFrame } from "@/components/email-frame.tsx";
import { LabelChips } from "@/components/labels-menu.tsx";
import { MessageMenu } from "@/components/message-menu.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tooltip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { linkifyText } from "@/lib/linkify.tsx";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import type { MessageRow } from "@/lib/queries.ts";
import { messageBodyQuery } from "@/lib/queries.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { formatDateTime } from "@/lib/time.ts";
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

// Real (non-inline) attachments, shown below the body with a download link.
// Inline `cid:` parts are embedded in the HTML and rewritten by the body
// endpoint, so they're filtered out here to avoid duplicating them.
function MessageAttachments({
  messageId,
  attachments,
  hasHtml,
}: {
  messageId: string;
  attachments: AttachmentDto[];
  hasHtml: boolean;
}) {
  const visible = attachments.filter((a) => !(hasHtml && a.inline && a.contentId));
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t bg-muted/30 px-4 py-3">
      {visible.map((att) => (
        <a
          key={att.id}
          href={`/api/messages/${messageId}/attachments/${att.id}/raw?download`}
          download={att.filename}
          className="group flex max-w-full items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-left shadow-black/[0.02] shadow-sm transition-colors hover:border-primary/40 hover:bg-muted"
        >
          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-[12px]">{att.filename}</span>
            <span className="block text-[11px] text-muted-foreground">
              {formatBytes(att.sizeBytes)}
            </span>
          </span>
          <Download className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </a>
      ))}
    </div>
  );
}

export function MessageCard({
  msg,
  cardRef,
  readOnly,
  onTrash,
  onRestore,
  onDelete,
  busy,
  onToggleStar,
}: {
  msg: MessageRow;
  cardRef?: React.Ref<HTMLElement>;
  readOnly: boolean;
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
  const bodyHtml = bodyData?.html ? sanitizeEmailHtml(bodyData.html) : null;
  const starred = hasFlag(msg.flags, Flag.STARRED);
  const when = new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt);

  return (
    <article
      ref={cardRef}
      className="overflow-hidden rounded-lg border bg-card shadow-black/[0.02] shadow-sm"
    >
      <header className="flex items-start justify-between gap-4 border-b px-4 py-2.5">
        <div className="min-w-0">
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
        subject={msg.subject}
        text={bodyData?.text}
        html={bodyData?.html}
        direction={msg.direction}
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
        <EmailFrame html={bodyHtml} />
      ) : (
        // Plain-text body once loaded (or the snippet if parsing yields neither).
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] px-4 py-3 font-sans text-[13px]">
          {linkifyText(bodyData?.text ?? msg.snippet)}
        </pre>
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
