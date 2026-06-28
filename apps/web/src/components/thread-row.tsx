import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type LucideIcon, Mails } from "lucide-react";
import type * as React from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn.ts";
import { useDateTimeFmt, useUserPrefs } from "@/lib/prefs.ts";
import {
  type MailView,
  type MessageLabel,
  messageBodyQuery,
  type ThreadRow,
  threadQuery,
} from "@/lib/queries.ts";
import { formatStamp } from "@/lib/time.ts";
import { useSwipeRow } from "@/lib/use-swipe-row.ts";
import { LabelChip } from "./ui.tsx";

/** One side of a swipe gesture: the reveal colour/icon and the action to run. */
export interface SwipeAction {
  icon: LucideIcon;
  label: string;
  /** Background colour class for the revealed panel, e.g. "bg-destructive". */
  className: string;
  onCommit: () => void;
}

export interface RowSwipe {
  /** Dragging the row right (→). */
  right?: SwipeAction;
  /** Dragging the row left (←). */
  left?: SwipeAction;
  onLongPress?: () => void;
}

// Subtle per-category chip colours for the AI auto-category. Kept muted so they
// don't compete with user labels; `other` is never rendered.
const CATEGORY_CLASS: Record<string, string> = {
  newsletter: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  receipt: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  travel: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  finance: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  social: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  personal: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  notification: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  promotion: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
};

// Where the row links to; both list flavors share one row body.
type RowLink =
  | { kind: "mailbox"; mailboxId: string; view: MailView }
  | { kind: "folder"; folderId: string };

interface Props {
  thread: ThreadRow;
  link: RowLink;
  active: boolean;
  /** Multi-select highlight (mailbox lists only). */
  selected?: boolean;
  /** Distinct labels across the thread's messages, shown as chips. */
  labels?: MessageLabel[];
  /** Leading column, e.g. the select checkbox. */
  leading?: React.ReactNode;
  /** Hover action cluster; omit to hide it (e.g. while selecting). */
  actions?: React.ReactNode;
  /** Virtualizer measurement ref + position; set together when windowed. */
  rowRef?: (el: HTMLLIElement | null) => void;
  style?: React.CSSProperties;
  dataIndex?: number;
  /** Force a fresh height re-measure for this row (async content changed it). */
  remeasure?: (index: number, el: HTMLLIElement) => void;
  /** Touch swipe + long-press gestures (mailbox lists only). */
  swipe?: RowSwipe;
}

export function ThreadRowView({
  thread,
  link,
  active,
  selected = false,
  labels,
  leading,
  actions,
  rowRef,
  style,
  dataIndex,
  remeasure,
  swipe,
}: Props) {
  const { prefs } = useUserPrefs();
  const fmt = useDateTimeFmt();
  const compact = prefs.density === "compact";
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;
  const showSummary = prefs.aiSummaries !== false && !!thread.aiSummary;
  const category = thread.aiCategory && thread.aiCategory !== "other" ? thread.aiCategory : null;
  const important = thread.aiPriority === "high";

  // Label chips come from a separate query that resolves after the row first
  // measures, growing it a line taller. The virtualizer's ResizeObserver doesn't
  // reliably catch that late change, leaving the rows below overlapped until a
  // re-render. Force a fresh height read when the row's line count can change.
  const node = useRef<HTMLLIElement | null>(null);
  const setRow = useCallback(
    (el: HTMLLIElement | null) => {
      node.current = el;
      rowRef?.(el);
    },
    [rowRef],
  );
  // Anything that adds/removes a line and can land after the first measure:
  // label chips (async query) plus summary/category (can stream in over SSE).
  const heightKey = `${labels?.map((l) => l.id).join(",") ?? ""}|${category ?? ""}|${showSummary ? 1 : 0}|${compact ? 1 : 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on height change
  useLayoutEffect(() => {
    if (node.current && dataIndex !== undefined) remeasure?.(dataIndex, node.current);
  }, [heightKey, dataIndex, remeasure]);

  // Router intent-preload already warms the thread's message list on hover, but
  // the per-message bodies (the slow part you see render as a skeleton) are
  // fetched only when the cards mount. Prefetch the newest few bodies on hover
  // intent so opening the thread paints the HTML at once. Bodies are immutable
  // (`staleTime: Infinity`), so this is a one-time fetch per message. A short
  // delay keeps a fast scroll-sweep over rows from firing requests.
  const qc = useQueryClient();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefetch = useCallback(() => {
    hoverTimer.current = setTimeout(() => {
      void qc
        .ensureQueryData(threadQuery(thread.id))
        .then((d) => {
          for (const m of d.messages.slice(-6)) void qc.prefetchQuery(messageBodyQuery(m.id));
        })
        .catch(() => {});
    }, 80);
  }, [qc, thread.id]);
  const cancelPrefetch = useCallback(() => clearTimeout(hoverTimer.current), []);
  useLayoutEffect(() => () => clearTimeout(hoverTimer.current), []);
  const hoverProps = {
    onPointerEnter: prefetch,
    onPointerLeave: cancelPrefetch,
    onFocus: prefetch,
  };

  const { state: sw, handlers } = useSwipeRow({
    onSwipeRight: swipe?.right?.onCommit,
    onSwipeLeft: swipe?.left?.onCommit,
    onLongPress: swipe?.onLongPress,
    disabled: !swipe,
  });

  // Without a leading column the body provides its own left padding.
  const linkClassName = cn(
    "flex min-w-0 flex-1 flex-col gap-0.5 pr-4 text-[13px]",
    compact ? "py-1.5" : "py-2.5",
    !leading && "pl-3",
  );

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("truncate", unread && "font-semibold")}>{label}</span>
        <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
          {formatStamp(thread.lastMsgAt, fmt)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "truncate text-[12px]",
            unread ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {thread.subjectNorm || "(no subject)"}
        </span>
        {unread && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            role="img"
            aria-label={`${thread.unreadCount} unread`}
          />
        )}
        {thread.msgCount > 1 && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1 font-medium text-[10px] text-muted-foreground"
            title={`${thread.msgCount} messages in this thread`}
          >
            <Mails className="h-2.5 w-2.5" />
            {thread.msgCount}
          </span>
        )}
      </div>
      {showSummary && (
        <span className="truncate text-[12px] text-muted-foreground/90 italic">
          {thread.aiSummary}
        </span>
      )}
      {(important || category || (labels && labels.length > 0)) && (
        <div className="flex flex-wrap items-center gap-1">
          {important && (
            <span className="inline-flex items-center rounded-full bg-red-500/10 px-1.5 py-px font-medium text-[10px] text-red-600 dark:text-red-400">
              Important
            </span>
          )}
          {category && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px font-medium text-[10px] capitalize",
                CATEGORY_CLASS[category],
              )}
            >
              {category}
            </span>
          )}
          {labels?.map((l) => (
            <LabelChip key={l.id} name={l.name} color={l.color} />
          ))}
        </div>
      )}
    </>
  );

  return (
    <li
      ref={setRow}
      data-index={dataIndex}
      style={style}
      className="group relative flex items-stretch overflow-hidden border-b bg-card"
    >
      {swipe?.right && sw.dx > 0 && (
        <SwipeReveal action={swipe.right} side="left" width={sw.dx} armed={sw.armed} />
      )}
      {swipe?.left && sw.dx < 0 && (
        <SwipeReveal action={swipe.left} side="right" width={-sw.dx} armed={sw.armed} />
      )}
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-stretch",
          sw.dragging ? "" : "transition-transform duration-200",
          active
            ? "bg-accent text-accent-foreground"
            : selected
              ? "bg-accent/40"
              : "bg-card hover:bg-muted/60",
        )}
        style={swipe ? { transform: `translateX(${sw.dx}px)`, touchAction: "pan-y" } : undefined}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onClickCapture={handlers.onClickCapture}
      >
        {active && <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />}
        {leading}
        {link.kind === "mailbox" ? (
          <Link
            to="/app/m/$mailboxId/t/$threadId"
            params={{ mailboxId: link.mailboxId, threadId: thread.id }}
            search={{ view: link.view }}
            draggable={false}
            className={linkClassName}
            {...hoverProps}
          >
            {body}
          </Link>
        ) : (
          <Link
            to="/app/folder/$folderId/t/$threadId"
            params={{ folderId: link.folderId, threadId: thread.id }}
            draggable={false}
            className={linkClassName}
            {...hoverProps}
          >
            {body}
          </Link>
        )}
        {actions && (
          <div className="absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-muted-foreground shadow-sm">
              {actions}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

// The coloured panel revealed behind a row mid-swipe. Its icon hugs the edge the
// finger is pulling from and brightens once the swipe passes the commit point.
function SwipeReveal({
  action,
  side,
  width,
  armed,
}: {
  action: SwipeAction;
  side: "left" | "right";
  width: number;
  armed: boolean;
}) {
  const Icon = action.icon;
  return (
    <div
      aria-hidden
      className={cn(
        "absolute inset-y-0 flex items-center text-white transition-opacity",
        action.className,
        side === "left" ? "left-0 justify-start pl-5" : "right-0 justify-end pr-5",
        armed ? "opacity-100" : "opacity-70",
      )}
      style={{ width: Math.max(width, 0) }}
    >
      <Icon className={cn("h-5 w-5 shrink-0 transition-transform", armed && "scale-125")} />
    </div>
  );
}
