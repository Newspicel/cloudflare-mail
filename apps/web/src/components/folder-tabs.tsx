import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  FileText,
  Inbox,
  type LucideIcon,
  Mails,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/cn.ts";
import { folderCountsQuery, MAIL_VIEWS, type MailView } from "@/lib/queries.ts";
import { Tooltip } from "./ui/tooltip.tsx";

export const FOLDER_META: Record<MailView, { label: string; icon: LucideIcon; empty: string }> = {
  inbox: { label: "Inbox", icon: Inbox, empty: "No conversations yet." },
  drafts: { label: "Drafts", icon: FileText, empty: "No drafts." },
  sent: { label: "Sent", icon: Send, empty: "Nothing sent yet." },
  marked: { label: "Marked", icon: Star, empty: "No marked conversations." },
  spam: { label: "Spam", icon: ShieldAlert, empty: "No spam." },
  trash: { label: "Trash", icon: Trash2, empty: "Trash is empty." },
  all: { label: "All Mail", icon: Mails, empty: "No mail." },
};

export function FolderTabs({ mailboxId, view }: { mailboxId: string; view: MailView }) {
  const { data } = useQuery(folderCountsQuery(mailboxId));
  return (
    <div className="flex flex-1 items-center justify-between gap-0.5 rounded-lg bg-muted p-0.5">
      {MAIL_VIEWS.map((v) => {
        const m = FOLDER_META[v];
        const active = v === view;
        const c = data?.counts[v];
        // Elevate to the unread count (accent) where it's meaningful, else the
        // bucket total (muted). No badge for empty folders.
        const unread = c?.unread ?? 0;
        const n = unread > 0 ? unread : (c?.total ?? 0);
        const label = unread > 0 ? `${m.label} · ${unread} unread` : `${m.label} · ${n}`;
        return (
          <Tooltip key={v} label={label}>
            <Link
              to="/app/m/$mailboxId"
              params={{ mailboxId }}
              search={{ view: v }}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors",
                active
                  ? "bg-card text-foreground shadow-black/5 shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <m.icon className="h-3.5 w-3.5" />
              {n > 0 && (
                <span
                  className={cn(
                    "-top-1 -right-1 absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 font-medium text-[9px] tabular-nums leading-none",
                    unread > 0
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted-foreground/25 text-muted-foreground",
                  )}
                >
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </Link>
          </Tooltip>
        );
      })}
    </div>
  );
}
