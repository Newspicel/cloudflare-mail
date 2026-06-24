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
import { folderCountsQuery, MAIL_VIEWS, type MailView } from "@/lib/queries.ts";
import { Tabs, TabsIndicator, TabsList, TabsTab } from "./ui/tabs.tsx";
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
    <Tabs value={view} className="flex-1">
      <TabsList className="w-full">
        {MAIL_VIEWS.map((v) => {
          const m = FOLDER_META[v];
          // Only surface a badge for unread mail — totals stay out of the tab bar.
          const unread = data?.counts[v]?.unread ?? 0;
          const label = unread > 0 ? `${m.label} · ${unread} unread` : m.label;
          return (
            <Tooltip key={v} label={label}>
              <TabsTab
                value={v}
                aria-label={label}
                className="relative flex-1 px-0"
                render={
                  <Link to="/app/m/$mailboxId" params={{ mailboxId }} search={{ view: v }} />
                }
              >
                <m.icon />
                {unread > 0 && (
                  <span className="-top-1 -right-1 absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[9px] text-primary-foreground tabular-nums leading-none">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </TabsTab>
            </Tooltip>
          );
        })}
        <TabsIndicator />
      </TabsList>
    </Tabs>
  );
}
