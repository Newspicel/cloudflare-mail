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
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col border-r bg-sidebar text-sidebar-foreground transition-transform md:static md:z-auto md:w-60 md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex flex-col gap-2 border-b border-sidebar-border px-3 py-3">
          <button
            type="button"
            onClick={() => {
              openCompose();
              onClose?.();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground transition hover:brightness-105"
          >
            <PenSquare className="h-3.5 w-3.5" /> Compose
          </button>
          <NewTempMailbox />
        </div>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
          {(Object.keys(grouped) as MailboxSummary["type"][]).map((type) => {
            const items = grouped[type];
            if (!items.length) return null;
            const meta = GROUP_META[type];
            return (
              <section key={type}>
                <h3 className="mb-1 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <meta.icon className="h-3 w-3" /> {meta.label}
                </h3>
                <ul className="flex flex-col">
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
                            "group flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition",
                            activeId === m.id
                              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                              : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                          )}
                        >
                          <span className="truncate">{m.displayName ?? m.address}</span>
                          <span className="ml-2 flex shrink-0 items-center gap-1">
                            {readOnly && (
                              <span role="img" aria-label="Read-only" title="Read-only">
                                <Lock className="h-3 w-3 text-muted-foreground" />
                              </span>
                            )}
                            {m.expiresAt && <TtlBadge expiresAt={m.expiresAt} />}
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
            <div className="mx-2 rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
              <Mailbox className="mb-1.5 h-3.5 w-3.5" />
              No mailboxes — create one from Admin.
            </div>
          )}
        </nav>

        <div className="border-t border-sidebar-border px-2 py-2">
          <Link
            to="/app/admin"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Admin
          </Link>
        </div>
      </aside>
    </>
  );
}

function TtlBadge({ expiresAt }: { expiresAt: string }) {
  const remaining = formatRemaining(expiresAt);
  if (!remaining) return null;
  const expired = remaining === "expired";
  return (
    <span
      title={`Expires ${new Date(expiresAt).toLocaleString()}`}
      className={cn(
        "rounded px-1 py-0.5 text-[10px] font-medium",
        expired ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
      )}
    >
      {remaining}
    </span>
  );
}
