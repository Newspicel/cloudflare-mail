import { has, Perm } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Inbox,
  Lock,
  Mailbox,
  Mails,
  PenSquare,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Trash2,
  Users,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { ALL_MAILBOXES, foldersQuery, type MailboxSummary, mailboxesQuery } from "@/lib/queries.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { openCompose } from "./compose-dock.tsx";
import { FoldersNav } from "./folders-nav.tsx";
import { NewTempMailbox } from "./new-temp-mailbox.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { Sheet, SheetContent } from "./ui/sheet.tsx";
import { UnreadBadge } from "./ui.tsx";

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
  // Subscribe so the gliding indicator re-measures once folders load/change.
  useQuery(foldersQuery);
  useNow(60_000);

  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirmDelete } = useConfirmHelpers();
  const params = useParams({ strict: false });
  const activeId = (params as { mailboxId?: string }).mailboxId;

  // Gliding active-row indicator (vertical sibling of the tab bar's slider):
  // measure the active link inside the scroll area each render and slide a single
  // card to it. Applied imperatively so there's no extra render pass.
  const navRef = useRef<HTMLElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = navRef.current;
    const bar = indRef.current;
    if (!node || !bar) return;
    const active = node.querySelector<HTMLElement>("[data-active-nav]");
    if (!active) {
      bar.style.opacity = "0";
      return;
    }
    const r = active.getBoundingClientRect();
    const top = r.top - node.getBoundingClientRect().top + node.scrollTop;
    bar.style.height = `${r.height}px`;
    bar.style.transform = `translateY(${top}px)`;
    bar.style.opacity = "1";
  });

  const deleteMailbox = useMutation({
    mutationFn: (id: string) => unwrap(rpc.mailboxes[":id"].$delete({ param: { id } })),
    onSuccess: (_res, id) => {
      qc.setQueryData<{ mailboxes: MailboxSummary[] }>(mailboxesQuery.queryKey, (old) =>
        old ? { mailboxes: old.mailboxes.filter((m) => m.id !== id) } : old,
      );
      if (activeId === id) nav({ to: "/app" });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to delete"),
  });

  const onDeleteTemp = async (m: MailboxSummary) => {
    const ok = await confirmDelete(
      "temp mailbox",
      `${m.address} and all its mail will be permanently deleted.`,
    );
    if (ok) deleteMailbox.mutate(m.id);
  };

  const grouped: Record<MailboxSummary["type"], MailboxSummary[]> = {
    personal: [],
    group: [],
    service: [],
    temp: [],
  };
  for (const m of mailboxes) grouped[m.type].push(m);

  const totalUnread = mailboxes.reduce((sum, m) => sum + m.unread, 0);

  return (
    <>
      <div className="flex flex-col gap-2 border-sidebar-border border-b px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
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

      <nav ref={navRef} className="relative flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
        <span
          ref={indRef}
          aria-hidden
          className="pointer-events-none absolute top-0 right-2 left-2 z-0 rounded-md bg-sidebar-accent opacity-0 transition-transform duration-200 ease-out motion-reduce:transition-none"
        />
        {mailboxes.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            <li>
              <Link
                to="/app/m/$mailboxId"
                params={{ mailboxId: ALL_MAILBOXES }}
                search={{ view: "inbox" }}
                onClick={() => onClose?.()}
                data-active-nav={activeId === ALL_MAILBOXES || undefined}
                className={cn(
                  "relative z-10 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition-colors",
                  activeId === ALL_MAILBOXES
                    ? "font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                )}
              >
                <span className={cn("flex items-center gap-2", totalUnread > 0 && "font-medium")}>
                  <Mails className="h-3.5 w-3.5 text-muted-foreground" /> All Mail
                </span>
                <UnreadBadge count={totalUnread} className="ml-2 shrink-0" />
              </Link>
            </li>
          </ul>
        )}

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
                  const canDelete = m.type === "temp" && m.role === "owner";
                  return (
                    <li key={m.id} className="group/row relative">
                      <Link
                        to="/app/m/$mailboxId"
                        params={{ mailboxId: m.id }}
                        search={{ view: "inbox" }}
                        onClick={() => onClose?.()}
                        data-active-nav={activeId === m.id || undefined}
                        className={cn(
                          "relative z-10 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition-colors",
                          activeId === m.id
                            ? "font-medium text-sidebar-accent-foreground"
                            : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                        )}
                      >
                        <span className={cn("truncate", m.unread > 0 && "font-medium")}>
                          {m.displayName ?? m.address}
                        </span>
                        <span
                          className={cn(
                            "ml-2 flex shrink-0 items-center gap-1",
                            canDelete && "group-hover/row:invisible",
                          )}
                        >
                          {readOnly && (
                            // eslint-disable-next-line react-doctor/prefer-tag-over-role -- icon wrapper conveying read-only status; not a real image
                            <span role="img" aria-label="Read-only" title="Read-only">
                              <Lock className="h-3 w-3 text-muted-foreground" />
                            </span>
                          )}
                          {m.expiresAt && <TtlBadge expiresAt={m.expiresAt} />}
                          <UnreadBadge count={m.unread} />
                        </span>
                      </Link>
                      {canDelete && (
                        <button
                          type="button"
                          aria-label={`Delete ${m.address}`}
                          title="Delete temp mailbox"
                          disabled={deleteMailbox.isPending}
                          onClick={() => onDeleteTemp(m)}
                          className="absolute inset-y-0 right-1 my-auto hidden h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover/row:flex"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
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

        <FoldersNav onClose={onClose} />
      </nav>

      <div className="border-sidebar-border border-t px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
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
