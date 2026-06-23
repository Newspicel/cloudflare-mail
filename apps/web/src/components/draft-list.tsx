import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import type { DraftRow, MailView } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { openCompose } from "./compose-dock.tsx";
import { FOLDER_META, FolderTabs } from "./folder-tabs.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";
import { EmptyState, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  mailboxId: string;
  view: MailView;
  drafts: DraftRow[];
  loading?: boolean;
}

export function DraftList({ mailboxId, view, drafts, loading }: Props) {
  const meta = FOLDER_META.drafts;
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/drafts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.drafts(mailboxId) });
      qc.invalidateQueries({ queryKey: keys.folderCounts(mailboxId) });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-card">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
          <FolderTabs mailboxId={mailboxId} view={view} />
          <span className="ml-auto pr-1 text-[11px] text-muted-foreground tabular-nums">
            {drafts.length}
          </span>
        </div>
        {loading ? (
          <ThreadListSkeleton />
        ) : drafts.length === 0 ? (
          <EmptyState icon={meta.icon} title={meta.empty} className="m-auto" />
        ) : (
          <ul className="flex-1 overflow-y-auto">
            {drafts.map((d) => {
              const recipients =
                d.toAddrs.map((a) => a.name ?? a.address).join(", ") || "(no recipient)";
              return (
                <li key={d.id} className="group relative flex items-stretch border-b">
                  <button
                    type="button"
                    onClick={() => openCompose({ draft: d })}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pr-4 pl-3 text-left text-[13px] transition-colors hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground">To: {recipients}</span>
                      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                        {formatTime(d.updatedAt)}
                      </span>
                    </div>
                    <div className="truncate font-medium text-[12px] text-foreground">
                      {d.subject || "(no subject)"}
                    </div>
                    {d.body.trim() && (
                      <div className="truncate text-[12px] text-muted-foreground">{d.body}</div>
                    )}
                  </button>
                  <div className="flex w-9 shrink-0 items-center justify-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <Tooltip label="Discard draft">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(d.id)}
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
        )}
      </div>
    </TooltipProvider>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
