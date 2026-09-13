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
import { folderCountsQuery, listSearch, MAIL_VIEWS, type MailView } from "@/lib/queries.ts";
import { Tabs, TabsIndicator, TabsList, TabsTab } from "./ui/tabs.tsx";
import { Tooltip } from "./ui/tooltip.tsx";
import { UnreadBadge } from "./ui.tsx";

export const FOLDER_META: Record<MailView, { label: string; icon: LucideIcon; empty: string }> = {
  inbox: { label: "Inbox", icon: Inbox, empty: "No conversations yet." },
  drafts: { label: "Drafts", icon: FileText, empty: "No drafts." },
  sent: { label: "Sent", icon: Send, empty: "Nothing sent yet." },
  marked: { label: "Marked", icon: Star, empty: "No marked conversations." },
  spam: { label: "Spam", icon: ShieldAlert, empty: "No spam." },
  trash: { label: "Trash", icon: Trash2, empty: "Trash is empty." },
  all: { label: "All Mail", icon: Mails, empty: "No mail." },
};

export function FolderTabs({
  mailboxId,
  view,
  unread,
}: {
  mailboxId: string;
  view: MailView;
  /** Unread-only filter is a mode of the list, so switching tabs keeps it. */
  unread?: boolean;
}) {
  const { data } = useQuery(folderCountsQuery(mailboxId));
  return (
    <Tabs value={view} className="flex-1">
      <TabsList className="w-full">
        {MAIL_VIEWS.map((v) => {
          const m = FOLDER_META[v];
          // Only surface a badge for unread mail — totals stay out of the tab bar.
          const unreadCount = data?.counts[v]?.unread ?? 0;
          const label = unreadCount > 0 ? `${m.label} · ${unreadCount} unread` : m.label;
          return (
            <Tooltip key={v} label={label}>
              <TabsTab
                value={v}
                aria-label={label}
                className="relative flex-1 px-0"
                render={
                  <Link
                    to="/app/m/$mailboxId"
                    params={{ mailboxId }}
                    search={listSearch(v, unread)}
                  />
                }
              >
                <m.icon />
                <UnreadBadge
                  count={unreadCount}
                  className="-top-1 -right-1 absolute h-3.5 min-w-3.5 font-medium text-[9px]"
                />
              </TabsTab>
            </Tooltip>
          );
        })}
        <TabsIndicator />
      </TabsList>
    </Tabs>
  );
}
