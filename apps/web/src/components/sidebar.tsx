import { has, Perm } from "@cfmail/shared/permissions";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Archive, Inbox, Lock, Mailbox, PenSquare, ShieldCheck, Timer, Users } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { type MailboxSummary, mailboxesQuery } from "@/lib/queries.ts";
import { openCompose } from "./compose-dock.tsx";
import { NewTempMailbox } from "./new-temp-mailbox.tsx";

const GROUP_META: Record<
  MailboxSummary["type"],
  { label: string; icon: (props: { className?: string }) => ReactNode }
> = {
  personal: { label: "Personal", icon: (p) => <Inbox {...p} /> },
  group: { label: "Groups", icon: (p) => <Users {...p} /> },
  service: { label: "Service", icon: (p) => <ShieldCheck {...p} /> },
  temp: { label: "Temporary", icon: (p) => <Timer {...p} /> },
};

export function Sidebar() {
  const { data } = useQuery(mailboxesQuery);
  const mailboxes = data?.mailboxes ?? [];

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
    <aside className="flex w-64 shrink-0 flex-col gap-1 border-r bg-sidebar px-3 py-4 text-sidebar-foreground">
      <button
        type="button"
        onClick={() => openCompose()}
        className="mb-2 flex items-center gap-2 self-start rounded-2xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm hover:brightness-105"
      >
        <PenSquare className="h-4 w-4" /> Compose
      </button>

      <div className="mb-3">
        <NewTempMailbox />
      </div>

      <nav className="flex flex-col gap-4 overflow-y-auto pr-1">
        {(Object.keys(grouped) as MailboxSummary["type"][]).map((type) => {
          const items = grouped[type];
          if (!items.length) return null;
          const meta = GROUP_META[type];
          return (
            <section key={type}>
              <h3 className="mb-1 flex items-center gap-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <meta.icon className="h-3.5 w-3.5" /> {meta.label}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {items.map((m) => {
                  const readOnly = m.role === "member" && !has(m.perms, Perm.WRITE);
                  return (
                    <li key={m.id}>
                      <Link
                        to="/app/m/$mailboxId"
                        params={{ mailboxId: m.id }}
                        className={cn(
                          "flex items-center justify-between rounded-full px-3 py-2 text-sm transition",
                          activeId === m.id
                            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                            : "hover:bg-sidebar-accent/60",
                        )}
                      >
                        <span className="truncate">{m.displayName ?? m.address}</span>
                        <span className="ml-2 flex shrink-0 items-center gap-1">
                          {readOnly && (
                            <span role="img" aria-label="Read-only" title="Read-only">
                              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                            </span>
                          )}
                          {m.expiresAt && (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              TTL
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
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
            <Mailbox className="mb-2 h-4 w-4" />
            No mailboxes — create one from Admin.
          </div>
        )}
      </nav>

      <div className="mt-auto pt-3">
        <Link
          to="/app/admin"
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
        >
          <Archive className="h-4 w-4" /> Admin
        </Link>
      </div>
    </aside>
  );
}
