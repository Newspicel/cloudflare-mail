import { has, Perm } from "@cfmail/shared/permissions";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Inbox,
  Lock,
  Mailbox,
  PenSquare,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { type MailboxSummary, mailboxesQuery } from "@/lib/queries.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { openCompose } from "./compose-dock.tsx";
import { NewTempMailbox } from "./new-temp-mailbox.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Sheet, SheetContent } from "./ui/sheet.tsx";

const GROUP_META: Record<
  MailboxSummary["type"],
  { label: string; icon: (props: { className?: string }) => ReactNode }
> = {
  personal: { label: "Personal", icon: (p) => <Inbox {...p} /> },
  group: { label: "Groups", icon: (p) => <Users {...p} /> },
  service: { label: "Service", icon: (p) => <ShieldCheck {...p} /> },
  temp: { label: "Temporary", icon: (p) => <Timer {...p} /> },
};

export function Sidebar({
  mobileOpen = false,
  onClose,
}: {
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  return (
    <>
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <SidebarBody onClose={onClose} />
      </aside>
      <Sheet
        open={mobileOpen}
        onOpenChange={(next) => {
          if (!next) onClose?.();
        }}
      >
        <SheetContent side="left" className="md:hidden">
          <SidebarBody onClose={onClose} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function SidebarBody({ onClose }: { onClose?: () => void }) {
  const { data } = useQuery(mailboxesQuery);
  const mailboxes = data?.mailboxes ?? [];
  useNow(60_000);

  const grouped: Record<MailboxSummary["type"], MailboxSummary[]> = {
    personal: [],
    group: [],
    service: [],
    temp: [],
  };
  for (const m of mailboxes) grouped[m.type].push(m);

  const params = useParams({ strict: false });
  const activeId = (params as { mailboxId?: string }).mailboxId;

  return (
    <>
      <div className="flex flex-col gap-2 border-sidebar-border border-b px-3 py-3">
        <Button
          variant="primary"
          className="w-full justify-start gap-2.5 rounded-lg px-3.5 shadow-primary/20"
          onClick={() => {
            openCompose();
            onClose?.();
          }}
        >
          <PenSquare /> Compose
        </Button>
        <NewTempMailbox />
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
        {(Object.keys(grouped) as MailboxSummary["type"][]).map((type) => {
          const items = grouped[type];
          if (!items.length) return null;
          const meta = GROUP_META[type];
          return (
            <section key={type}>
              <h3 className="mb-1 flex items-center gap-1.5 px-2 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
                <meta.icon className="h-3 w-3" /> {meta.label}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {items.map((m) => {
                  const readOnly = m.role === "member" && !has(m.perms, Perm.WRITE);
                  return (
                    <li key={m.id}>
                      <Link
                        to="/app/m/$mailboxId"
                        params={{ mailboxId: m.id }}
                        search={{ view: "inbox" }}
                        onClick={() => onClose?.()}
                        className={cn(
                          "group flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition-colors",
                          activeId === m.id
                            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                            : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                        )}
                      >
                        <span className={cn("truncate", m.unread > 0 && "font-medium")}>
                          {m.displayName ?? m.address}
                        </span>
                        <span className="ml-2 flex shrink-0 items-center gap-1">
                          {readOnly && (
                            <span role="img" aria-label="Read-only" title="Read-only">
                              <Lock className="h-3 w-3 text-muted-foreground" />
                            </span>
                          )}
                          {m.expiresAt && <TtlBadge expiresAt={m.expiresAt} />}
                          {m.unread > 0 && (
                            <span
                              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-semibold text-[10px] text-primary-foreground tabular-nums leading-none"
                              role="img"
                              aria-label={`${m.unread} unread`}
                            >
                              {m.unread > 99 ? "99+" : m.unread}
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {mailboxes.length === 0 && (
          <div className="mx-2 rounded-lg border border-dashed p-3 text-[11px] text-muted-foreground">
            <Mailbox className="mb-1.5 h-3.5 w-3.5" />
            No mailboxes — create one from Admin.
          </div>
        )}
      </nav>

      <div className="border-sidebar-border border-t px-2 py-2">
        <Link
          to="/app/admin"
          onClick={() => onClose?.()}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> Admin
        </Link>
      </div>
    </>
  );
}

function TtlBadge({ expiresAt }: { expiresAt: string }) {
  const remaining = formatRemaining(expiresAt);
  if (!remaining) return null;
  const expired = remaining === "expired";
  return (
    <Badge
      variant={expired ? "destructive" : "outline"}
      title={`Expires ${new Date(expiresAt).toLocaleString()}`}
    >
      {remaining}
    </Badge>
  );
}
