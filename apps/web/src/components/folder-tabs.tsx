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
  const activeIndex = Math.max(0, MAIL_VIEWS.indexOf(view));
  return (
    <div className="relative flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {/* Gliding active-tab indicator: tabs are fixed w-7 with gap-0.5, so the
          card slides by index * (tab width + gap). */}
      <span
        aria-hidden
        className="absolute top-0.5 left-0.5 h-7 w-7 rounded-md bg-card shadow-black/5 shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(calc(${activeIndex} * (1.75rem + 0.125rem)))` }}
      />
      {MAIL_VIEWS.map((v) => {
        const m = FOLDER_META[v];
        const active = v === view;
        // Only surface a badge for unread mail — totals stay out of the tab bar.
        const unread = data?.counts[v]?.unread ?? 0;
        const label = unread > 0 ? `${m.label} · ${unread} unread` : m.label;
        return (
          <Tooltip key={v} label={label}>
            <Link
              to="/app/m/$mailboxId"
              params={{ mailboxId }}
              search={{ view: v }}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <m.icon className="h-3.5 w-3.5" />
              {unread > 0 && (
                <span className="-top-1 -right-1 absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[9px] text-primary-foreground tabular-nums leading-none">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
          </Tooltip>
        );
      })}
    </div>
  );
}
