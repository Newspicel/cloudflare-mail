import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CalendarX2, Trash2 } from "lucide-react";
import { type CSSProperties, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import type { DraftRow, MailView } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { formatStamp } from "@/lib/time.ts";
import { useListVirtualizer } from "@/lib/use-list-virtualizer.ts";
import { openCompose } from "./compose-dock.tsx";
import { FOLDER_META, FolderTabs } from "./folder-tabs.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";
import { EmptyState, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  mailboxId: string;
  view: MailView;
  drafts: DraftRow[];
  loading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMore?: () => void;
}

// Absolute placement for a virtualized row at `start` px down the spacer.
function rowStyle(start: number): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${start}px)`,
  };
}

export function DraftList({
  mailboxId,
  view,
  drafts,
  loading,
  hasMore = false,
  loadingMore = false,
  loadMore,
}: Props) {
  const meta = FOLDER_META.drafts;
  const qc = useQueryClient();
  const fmt = useDateTimeFmt();
  const { confirmDelete } = useConfirmHelpers();

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useListVirtualizer(scrollRef, drafts.length, {
    infinite: { hasMore, loadingMore, loadMore: () => loadMore?.() },
    cacheKey: `m:${mailboxId}:drafts`,
  });
  const vItems = virtualizer.getVirtualItems();

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/drafts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.drafts(mailboxId) });
      qc.invalidateQueries({ queryKey: keys.folderCounts(mailboxId) });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Clear a draft's scheduled/failed state — reverts it to an ordinary draft.
  const unschedule = useMutation({
    mutationFn: (id: string) => api(`/api/drafts/${id}/schedule`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.drafts(mailboxId) }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  function cancelSchedule(id: string) {
    unschedule.mutate(id);
    toast.success("Scheduled send canceled");
  }

  // Opening a scheduled draft cancels its schedule first — editing a draft whose
  // payload is already queued to send would otherwise fire the stale version. A
  // failed draft just has its stale error flag cleared as it's reopened.
  function openDraft(d: DraftRow) {
    if (d.scheduledFor) {
      unschedule.mutate(d.id);
      toast("Scheduled send canceled — editing draft");
    } else if (d.scheduledError) {
      unschedule.mutate(d.id);
    }
    openCompose({ draft: d });
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-card">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
          <FolderTabs mailboxId={mailboxId} view={view} />
        </div>
        {loading ? (
          <ThreadListSkeleton />
        ) : drafts.length === 0 ? (
          <EmptyState icon={meta.icon} title={meta.empty} className="m-auto" />
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {vItems.map((vi) => {
                const d = drafts[vi.index]!;
                const recipients =
                  d.toAddrs.map((a) => a.name ?? a.address).join(", ") || "(no recipient)";
                return (
                  <li
                    key={d.id}
                    ref={virtualizer.measureElement}
                    data-index={vi.index}
                    style={rowStyle(vi.start)}
                    className="group flex items-stretch border-b"
                  >
                    <button
                      type="button"
                      onClick={() => openDraft(d)}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pr-4 pl-3 text-left text-[13px] transition-colors hover:bg-muted/60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-muted-foreground">To: {recipients}</span>
                        <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                          {formatStamp(d.updatedAt, fmt)}
                        </span>
                      </div>
                      <div className="truncate font-medium text-[12px] text-foreground">
                        {d.subject || "(no subject)"}
                      </div>
                      {d.scheduledFor ? (
                        <div className="flex items-center gap-1 font-medium text-[11px] text-amber-600 dark:text-amber-500">
                          <CalendarClock className="h-3 w-3" />
                          Sends {formatStamp(d.scheduledFor, fmt)}
                        </div>
                      ) : d.scheduledError ? (
                        <div className="flex items-center gap-1 truncate font-medium text-[11px] text-destructive">
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span className="truncate">Send failed — {d.scheduledError}</span>
                        </div>
                      ) : (
                        d.body.trim() && (
                          <div className="truncate text-[12px] text-muted-foreground">{d.body}</div>
                        )
                      )}
                    </button>
                    <div
                      className={cn(
                        "flex shrink-0 items-center justify-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
                        d.scheduledFor ? "w-[4.25rem]" : "w-9",
                      )}
                    >
                      {d.scheduledFor && (
                        <Tooltip label="Cancel scheduled send">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={unschedule.isPending}
                            onClick={() => cancelSchedule(d.id)}
                            aria-label="Cancel scheduled send"
                          >
                            <CalendarX2 />
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip label="Discard draft">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={remove.isPending}
                          onClick={async () => {
                            if (await confirmDelete("this draft")) remove.mutate(d.id);
                          }}
                          aria-label="Discard draft"
                          className="hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
                      </Tooltip>
                    </div>
                  </li>
                );
              })}
            </ul>
            {loadingMore && (
              <div className="py-3 text-center text-[11px] text-muted-foreground">
                Loading more…
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
