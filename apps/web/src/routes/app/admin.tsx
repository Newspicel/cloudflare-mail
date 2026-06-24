import { has, MailboxKind, Perm, type PermBit } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Check, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { MailboxSettingsForm } from "@/components/mailbox-settings-form.tsx";
import { TokenField } from "@/components/token-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { useConfirm, useConfirmHelpers } from "@/components/ui/confirm.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { inputClass } from "@/components/ui/input.tsx";
import {
  SelectContent,
  SelectItem,
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { type MailboxSummary, mailboxesQuery, meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/admin")({
  component: AdminPage,
});

interface Domain {
  id: string;
  name: string;
  allowedKinds: number;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  lastCheckedAt: string | null;
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  banned: boolean;
  createdAt: string;
}

interface UserInviteRow {
  id: string;
  email: string;
  role: "admin" | "user";
  expiresAt: string;
  usedAt: string | null;
}

interface DomainGrantRow {
  domainId: string;
  domainName: string;
  allowedKinds: number;
}

interface Member {
  userId: string;
  email: string;
  name: string;
  perms: number;
}

interface DirectoryUser {
  id: string;
  email: string;
  name: string;
}

interface AdminMailbox {
  id: string;
  address: string;
  displayName: string | null;
  type: "personal" | "group" | "service" | "temp";
  expiresAt: string | null;
  ownerUserId: string;
  ownerEmail: string;
  ownerName: string;
}

interface RedirectRow {
  id: string;
  address: string;
  targetMailboxId: string;
  targetAddress: string;
  createdAt: string;
}

type Tab = "domains" | "users" | "mailboxes" | "service" | "blocking";

interface ServiceMailbox {
  id: string;
  address: string;
  displayName: string | null;
  mode: "duplex" | "send";
  hasKey: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

function AdminPage() {
  const me = useQuery(meQuery);
  const isAdmin = me.data?.user?.role === "admin";
  const [tab, setTab] = useState<Tab>(isAdmin ? "domains" : "mailboxes");

  if (me.isLoading) {
    return <div className="p-8 text-[13px] text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <header>
          <h1 className="text-[22px] font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isAdmin
              ? "Manage domains, users, and mailboxes."
              : "Mailboxes you own or have been granted access to."}
          </p>
        </header>

        {isAdmin && (
          <div className="flex gap-6 border-b">
            <TabButton active={tab === "domains"} onClick={() => setTab("domains")}>
              Domains
            </TabButton>
            <TabButton active={tab === "users"} onClick={() => setTab("users")}>
              Users
            </TabButton>
            <TabButton active={tab === "mailboxes"} onClick={() => setTab("mailboxes")}>
              Mailboxes
            </TabButton>
            <TabButton active={tab === "service"} onClick={() => setTab("service")}>
              Service
            </TabButton>
            <TabButton active={tab === "blocking"} onClick={() => setTab("blocking")}>
              Blocking
            </TabButton>
          </div>
        )}

        {isAdmin && tab === "domains" && <DomainsSection />}
        {isAdmin && tab === "users" && <UsersSection />}
        {isAdmin && tab === "service" && <ServiceSection />}
        {isAdmin && tab === "blocking" && <BlockingSection />}
        {(tab === "mailboxes" || !isAdmin) && <MailboxesSection />}
      </div>
    </div>
  );
}

// ─── Building blocks ────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-1 py-2 text-[13px] font-medium transition",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border bg-card">
      <header className="flex items-start justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

type SelectOption = { value: string; label: string; disabled?: boolean };

// Thin wrapper over the shared styled Select so admin call sites stay compact:
// pass `options` instead of composing the trigger/content by hand.
function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  ariaLabel,
  title,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  title?: string;
}) {
  return (
    <SelectRoot
      value={value}
      onValueChange={(v) => onValueChange((v ?? "") as string)}
      disabled={disabled}
    >
      <SelectTrigger className={className} aria-label={ariaLabel} title={title}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

function PrimaryBtn({
  disabled,
  onClick,
  children,
  type = "button",
}: {
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <Button type={type} variant="primary" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

function GhostBtn({
  disabled,
  onClick,
  destructive,
  children,
}: {
  disabled?: boolean;
  onClick?: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {children}
    </Button>
  );
}

// ─── Domains ────────────────────────────────────────────────────────────────

const KIND_CHECKBOXES: { label: string; bit: number; type: MailboxSummary["type"] }[] = [
  { label: "personal", bit: MailboxKind.PERSONAL, type: "personal" },
  { label: "group", bit: MailboxKind.GROUP, type: "group" },
  { label: "service", bit: MailboxKind.SERVICE, type: "service" },
  { label: "temp", bit: MailboxKind.TEMP, type: "temp" },
];

function DomainsSection() {
  const qc = useQueryClient();
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const settingsQ = useQuery({
    queryKey: ["domains-settings"],
    queryFn: () => api<{ authFromAddress: string | null }>("/api/domains/settings"),
  });

  const [newDomain, setNewDomain] = useState("");
  const [newKinds, setNewKinds] = useState<number>(MailboxKind.PERSONAL);

  const addDomain = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/domains", {
        method: "POST",
        body: JSON.stringify({ name: newDomain, allowedKinds: newKinds }),
      }),
    onSuccess: () => {
      setNewDomain("");
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("Domain added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [fromAddr, setFromAddr] = useState("");
  const saveFrom = useMutation({
    mutationFn: () =>
      api("/api/domains/settings/auth-from", {
        method: "PUT",
        body: JSON.stringify({ address: fromAddr }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains-settings"] });
      toast.success("Saved");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="space-y-5">
      <Section
        title="Transactional email"
        description="Sender address for password-reset and invitation emails. Must be on a verified Email Sending domain."
      >
        <div className="flex gap-2">
          <Input
            value={fromAddr || settingsQ.data?.authFromAddress || ""}
            onChange={(e) => setFromAddr(e.target.value)}
            placeholder="noreply@example.com"
            className="flex-1"
          />
          <PrimaryBtn onClick={() => saveFrom.mutate()} disabled={!fromAddr || saveFrom.isPending}>
            Save
          </PrimaryBtn>
        </div>
      </Section>

      <Section
        title="Domains"
        description="Verified mail domains and the mailbox kinds each one allows."
      >
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[36rem] text-[13px]">
            <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Domain</th>
                <th className="px-3 py-2 text-left font-medium">DNS</th>
                <th className="px-3 py-2 text-left font-medium">Allowed kinds</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(domainsQ.data?.domains ?? []).map((d) => (
                <DomainRow key={d.id} domain={d} />
              ))}
              {domainsQ.data?.domains.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-8 text-center text-[12px] text-muted-foreground"
                  >
                    No domains yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
          <Input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="example.com"
            className="min-w-[200px] flex-1"
          />
          <KindCheckboxes value={newKinds} onChange={setNewKinds} />
          <PrimaryBtn
            onClick={() => addDomain.mutate()}
            disabled={!newDomain || addDomain.isPending}
          >
            Add domain
          </PrimaryBtn>
        </div>
      </Section>
    </div>
  );
}

function KindCheckboxes({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const baseId = useId();
  const toggle = (bit: number) => onChange((value & bit) === bit ? value & ~bit : value | bit);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {KIND_CHECKBOXES.map((k) => {
        const id = `${baseId}-${k.bit}`;
        return (
          <label
            key={k.label}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-1.5 select-none"
          >
            <Checkbox
              id={id}
              checked={(value & k.bit) === k.bit}
              onCheckedChange={() => toggle(k.bit)}
              className="size-3.5"
            />
            {k.label}
          </label>
        );
      })}
    </div>
  );
}

function DomainRow({ domain: d }: { domain: Domain }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const recheck = useMutation({
    mutationFn: () => api(`/api/domains/${d.id}/check`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("DNS rechecked");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const setKinds = useMutation({
    mutationFn: (allowedKinds: number) =>
      api(`/api/domains/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify({ allowedKinds }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const deleteDom = useMutation({
    mutationFn: () => api(`/api/domains/${d.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("Domain removed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const checkedLabel = d.lastCheckedAt
    ? `checked ${new Date(d.lastCheckedAt).toLocaleString()}`
    : "not yet checked";
  return (
    <tr>
      <td className="px-3 py-2.5 align-top">
        <div className="font-medium">{d.name}</div>
        <div className="text-[11px] text-muted-foreground">{checkedLabel}</div>
      </td>
      <td className="px-3 py-2.5 align-top">
        <div className="flex flex-wrap items-center gap-1">
          <DnsBadge label="SPF" ok={d.spfOk} checked={d.lastCheckedAt !== null} />
          <DnsBadge label="DKIM" ok={d.dkimOk} checked={d.lastCheckedAt !== null} />
          <DnsBadge label="DMARC" ok={d.dmarcOk} checked={d.lastCheckedAt !== null} />
        </div>
      </td>
      <td className="px-3 py-2.5 align-top">
        <KindCheckboxes value={d.allowedKinds} onChange={(v) => setKinds.mutate(v)} />
      </td>
      <td className="px-3 py-2.5 text-right align-top">
        <div className="flex items-center justify-end gap-2">
          <GhostBtn onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? "Checking…" : "Recheck"}
          </GhostBtn>
          <GhostBtn
            destructive
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${d.name}?`,
                description: "The domain and its DNS records will be removed from this instance.",
                confirmLabel: "Remove",
                destructive: true,
              });
              if (ok) deleteDom.mutate();
            }}
          >
            Remove
          </GhostBtn>
        </div>
      </td>
    </tr>
  );
}

function DnsBadge({ label, ok, checked }: { label: string; ok: boolean; checked: boolean }) {
  const cls = !checked
    ? "border-border bg-muted text-muted-foreground"
    : ok
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : "border-destructive/30 bg-destructive/10 text-destructive";
  const Icon = !checked ? null : ok ? Check : X;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] font-medium",
        cls,
      )}
      title={
        !checked
          ? "Not yet checked"
          : ok
            ? `${label} record found`
            : `${label} record missing or invalid`
      }
    >
      {Icon ? <Icon className="h-2.5 w-2.5" strokeWidth={3} /> : <span>·</span>}
      {label}
    </span>
  );
}

// ─── Users ──────────────────────────────────────────────────────────────────

function UsersSection() {
  const qc = useQueryClient();
  const usersQ = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api<{ users: AdminUser[] }>("/api/users"),
  });
  const invitesQ = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => api<{ invites: UserInviteRow[] }>("/api/users/invites"),
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "user">("user");
  const sendInvite = useMutation({
    mutationFn: () =>
      api<{ url: string; sentEmail: boolean }>("/api/users/invites", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      }),
    onSuccess: (res) => {
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["admin-invites"] });
      toast.success(res.sentEmail ? "Invite sent" : `Invite link: ${res.url}`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<"admin" | "user">("user");
  const createUser = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          email: createEmail,
          name: createName,
          password: createPassword,
          role: createRole,
        }),
      }),
    onSuccess: () => {
      setCreateEmail("");
      setCreateName("");
      setCreatePassword("");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("User created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="space-y-5">
      <Section title="Users" description="Everyone with access to this deployment.">
        <ul className="divide-y rounded-md border">
          {(usersQ.data?.users ?? []).map((u) => (
            <UserRow key={u.id} user={u} />
          ))}
          {usersQ.data?.users.length === 0 && (
            <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              No users yet.
            </li>
          )}
        </ul>
      </Section>

      <Section title="Send invite" description="User sets their own password via a one-time link.">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@example.com"
            className="min-w-[200px] flex-1"
          />
          <Select
            value={inviteRole}
            onValueChange={(v) => setInviteRole(v as typeof inviteRole)}
            className="w-auto"
            ariaLabel="Invite role"
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <PrimaryBtn
            onClick={() => sendInvite.mutate()}
            disabled={!inviteEmail || sendInvite.isPending}
          >
            Send invite
          </PrimaryBtn>
        </div>
        {(invitesQ.data?.invites ?? []).filter((i) => !i.usedAt).length > 0 && (
          <ul className="mt-4 divide-y rounded-md border">
            {(invitesQ.data?.invites ?? [])
              .filter((i) => !i.usedAt)
              .map((inv) => (
                <InviteRow key={inv.id} invite={inv} />
              ))}
          </ul>
        )}
      </Section>

      <Section
        title="Create user directly"
        description="Skip the invite flow — set the user's initial password yourself and share it out of band."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Name"
          />
          <Input
            type="email"
            value={createEmail}
            onChange={(e) => setCreateEmail(e.target.value)}
            placeholder="user@example.com"
          />
          <Input
            type="password"
            minLength={8}
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Initial password"
          />
          <Select
            value={createRole}
            onValueChange={(v) => setCreateRole(v as typeof createRole)}
            ariaLabel="Role"
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <PrimaryBtn
            onClick={() => createUser.mutate()}
            disabled={
              !createEmail || !createName || createPassword.length < 8 || createUser.isPending
            }
          >
            Create user
          </PrimaryBtn>
        </div>
      </Section>
    </div>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useQuery(meQuery);
  const isMe = me.data?.user?.id === user.id;
  const [open, setOpen] = useState(false);

  const setRole = useMutation({
    mutationFn: (role: "admin" | "user") =>
      api(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/users/${user.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("User removed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{user.name}</span>
            {isMe && (
              <span className="rounded border bg-muted px-1 py-0 text-[10px] font-medium text-muted-foreground">
                you
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={user.role}
            onValueChange={(v) => setRole.mutate(v as "admin" | "user")}
            disabled={isMe || setRole.isPending}
            className="h-7 text-[11px]"
            ariaLabel="Role"
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <GhostBtn onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Grants"}</GhostBtn>
          {!isMe && (
            <GhostBtn
              destructive
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${user.email}?`,
                  description: "This permanently removes the user account.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) remove.mutate();
              }}
            >
              Delete
            </GhostBtn>
          )}
        </div>
      </div>
      {open && <DomainGrantsPanel userId={user.id} />}
    </li>
  );
}

function InviteRow({ invite }: { invite: UserInviteRow }) {
  const qc = useQueryClient();
  const { confirm } = useConfirmHelpers();
  const revoke = useMutation({
    mutationFn: () => api(`/api/users/invites/${invite.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-invites"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
      <div className="min-w-0">
        <div className="truncate font-medium text-muted-foreground">{invite.email}</div>
        <div className="text-[11px] text-muted-foreground">
          {invite.role} · expires {new Date(invite.expiresAt).toLocaleString()}
        </div>
      </div>
      <GhostBtn
        destructive
        onClick={async () => {
          if (
            await confirm({
              title: `Revoke invite for ${invite.email}?`,
              description: "The invite link stops working immediately.",
              confirmLabel: "Revoke",
              destructive: true,
            })
          )
            revoke.mutate();
        }}
      >
        Revoke
      </GhostBtn>
    </li>
  );
}

function DomainGrantsPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const grantsQ = useQuery({
    queryKey: ["user-grants", userId],
    queryFn: () => api<{ grants: DomainGrantRow[] }>(`/api/users/${userId}/domain-grants`),
  });

  const setGrant = useMutation({
    mutationFn: ({ domainId, allowedKinds }: { domainId: string; allowedKinds: number }) =>
      api(`/api/users/${userId}/domain-grants/${domainId}`, {
        method: "PUT",
        body: JSON.stringify({ userId, allowedKinds }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-grants", userId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const grantByDomain = new Map(
    (grantsQ.data?.grants ?? []).map((g) => [g.domainId, g.allowedKinds]),
  );

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Per-domain mailbox-kind grants
      </div>
      <ul className="divide-y rounded-md border bg-card">
        {(domainsQ.data?.domains ?? []).map((d) => {
          const kinds = grantByDomain.get(d.id) ?? 0;
          return (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]"
            >
              <div className="min-w-0 flex-1 truncate">
                <div className="truncate font-medium">{d.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  domain allows: {d.allowedKinds ? renderKinds(d.allowedKinds) : "none"}
                </div>
              </div>
              <KindCheckboxes
                value={kinds & d.allowedKinds}
                onChange={(v) =>
                  setGrant.mutate({ domainId: d.id, allowedKinds: v & d.allowedKinds })
                }
              />
            </li>
          );
        })}
        {domainsQ.data?.domains.length === 0 && (
          <li className="px-3 py-3 text-center text-[11px] text-muted-foreground">
            No domains configured.
          </li>
        )}
      </ul>
    </div>
  );
}

function renderKinds(kinds: number): string {
  return KIND_CHECKBOXES.filter((k) => (kinds & k.bit) === k.bit)
    .map((k) => k.label)
    .join(", ");
}

// ─── Service mailboxes ────────────────────────────────────────────────────────

function ServiceSection() {
  const qc = useQueryClient();
  const servicesQ = useQuery({
    queryKey: ["admin-service"],
    queryFn: () => api<{ services: ServiceMailbox[] }>("/api/admin/service"),
  });
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });

  // The plaintext key is returned once on create/rotate — surface it in a modal.
  const [revealed, setRevealed] = useState<{ address: string; key: string } | null>(null);

  const eligibleDomains = (domainsQ.data?.domains ?? []).filter(
    (d) => (d.allowedKinds & MailboxKind.SERVICE) === MailboxKind.SERVICE,
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-service"] });
  const services = servicesQ.data?.services ?? [];

  return (
    <Section
      title="Service mailboxes"
      description={
        <>
          Key-driven send/receive mailboxes for integrations — no login, no sidebar. Authenticate to{" "}
          <Mono>/api/svc</Mono> with the bearer key. Inbound mail is kept for 30 days.
        </>
      }
    >
      <ul className="divide-y rounded-md border">
        {services.map((s) => (
          <ServiceRow key={s.id} service={s} onKey={setRevealed} invalidate={invalidate} />
        ))}
        {services.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-muted-foreground">
            No service mailboxes yet.
          </li>
        )}
      </ul>

      <div className="mt-4 border-t pt-4">
        {eligibleDomains.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            Enable the <span className="font-medium">service</span> kind on a domain (Domains tab)
            to create one here.
          </p>
        ) : (
          <ServiceCreateForm
            eligibleDomains={eligibleDomains}
            onCreated={(res, address) => {
              invalidate();
              setRevealed({ address, key: res.key });
            }}
          />
        )}
      </div>

      <ServiceKeyDialog info={revealed} onClose={() => setRevealed(null)} />
    </Section>
  );
}

function ServiceCreateForm({
  eligibleDomains,
  onCreated,
}: {
  eligibleDomains: Domain[];
  onCreated: (res: { id: string; key: string }, address: string) => void;
}) {
  const [local, setLocal] = useState("");
  const [domainId, setDomainId] = useState("");
  const [mode, setMode] = useState<"duplex" | "send">("duplex");

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; key: string }>("/api/admin/service", {
        method: "POST",
        body: JSON.stringify({ domainId, localPart: local, mode }),
      }),
    onSuccess: (res) => {
      const dom = eligibleDomains.find((d) => d.id === domainId);
      onCreated(res, `${local}@${dom?.name ?? ""}`);
      setLocal("");
      toast.success("Service mailbox created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder="local-part"
        className="min-w-[140px] flex-1"
      />
      <span className="text-[13px] text-muted-foreground">@</span>
      <Select
        value={domainId}
        onValueChange={setDomainId}
        className="min-w-[160px] flex-1"
        placeholder="Select domain…"
        ariaLabel="Domain"
        options={eligibleDomains.map((d) => ({ value: d.id, label: d.name }))}
      />
      <Select
        value={mode}
        onValueChange={(v) => setMode(v as "duplex" | "send")}
        title="Direction"
        ariaLabel="Direction"
        className="min-w-[130px]"
        options={[
          { value: "duplex", label: "send + receive" },
          { value: "send", label: "send-only" },
        ]}
      />
      <PrimaryBtn
        onClick={() => create.mutate()}
        disabled={!domainId || !local || create.isPending}
      >
        Add service
      </PrimaryBtn>
    </div>
  );
}

function ServiceRow({
  service: s,
  onKey,
  invalidate,
}: {
  service: ServiceMailbox;
  onKey: (info: { address: string; key: string }) => void;
  invalidate: () => void;
}) {
  const confirm = useConfirm();

  const rotate = useMutation({
    mutationFn: () => api<{ key: string }>(`/api/admin/service/${s.id}/rotate`, { method: "POST" }),
    onSuccess: (res) => {
      invalidate();
      onKey({ address: s.address, key: res.key });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const setMode = useMutation({
    mutationFn: (mode: "duplex" | "send") =>
      api(`/api/admin/service/${s.id}`, { method: "PATCH", body: JSON.stringify({ mode }) }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/admin/service/${s.id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast.success("Service mailbox deleted");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{s.address}</span>
            <KindBadge kind="service" />
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {s.mode === "send" ? "send-only" : "send + receive"} · {s.messageCount} stored
            {s.lastMessageAt && ` · last ${new Date(s.lastMessageAt).toLocaleString()}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={s.mode}
            onValueChange={(v) => setMode.mutate(v as "duplex" | "send")}
            disabled={setMode.isPending}
            className="h-7 text-[11px]"
            title="Direction"
            ariaLabel="Direction"
            options={[
              { value: "duplex", label: "send + receive" },
              { value: "send", label: "send-only" },
            ]}
          />
          <GhostBtn onClick={() => rotate.mutate()} disabled={rotate.isPending}>
            {rotate.isPending ? "Rotating…" : "Rotate key"}
          </GhostBtn>
          <GhostBtn
            destructive
            onClick={async () => {
              const ok = await confirm({
                title: `Delete ${s.address}?`,
                description: "The mailbox, its key, and all stored mail are removed permanently.",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) remove.mutate();
            }}
          >
            Delete
          </GhostBtn>
        </div>
      </div>
    </li>
  );
}

function ServiceKeyDialog({
  info,
  onClose,
}: {
  info: { address: string; key: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={Boolean(info)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key for {info?.address}</DialogTitle>
          <DialogDescription>
            Copy it now — it's shown only once. Authenticate as{" "}
            <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> against /api/svc.
            Rotating issues a new key and invalidates this one immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded border bg-muted px-2 py-1.5 font-mono text-[12px]">
            {info?.key}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (info) {
                navigator.clipboard.writeText(info.key);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : "Copy"}
          </Button>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="primary">Done</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Mailboxes & redirects ───────────────────────────────────────────────────

const TYPE_BADGE: Record<string, string> = {
  personal: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  group: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  service: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  temp: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
  redirect: "border-border bg-muted text-muted-foreground",
};

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize",
        TYPE_BADGE[kind] ?? TYPE_BADGE.redirect,
      )}
    >
      {kind}
    </span>
  );
}

type Entry =
  | { kind: "mailbox"; address: string; mb: AdminMailbox }
  | { kind: "redirect"; address: string; rd: RedirectRow };

const kindOf = (e: Entry) => (e.kind === "redirect" ? "redirect" : e.mb.type);

function MailboxesSection() {
  const me = useQuery(meQuery);
  const isAdmin = me.data?.user?.role === "admin";
  return isAdmin ? <AdminMailboxes meId={me.data?.user?.id ?? ""} /> : <OwnMailboxes />;
}

// Non-admin: only the mailboxes the user owns or was granted access to.
function OwnMailboxes() {
  const qc = useQueryClient();
  const me = useQuery(meQuery);
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const mailboxesQ = useQuery(mailboxesQuery);
  const grantsQ = useQuery({
    queryKey: ["user-grants", me.data?.user?.id],
    queryFn: () =>
      api<{ grants: DomainGrantRow[] }>(`/api/users/${me.data?.user?.id}/domain-grants`),
    enabled: Boolean(me.data?.user?.id),
  });

  const grantByDomain = new Map(
    (grantsQ.data?.grants ?? []).map((g) => [g.domainId, g.allowedKinds]),
  );
  const eligibleDomains = (domainsQ.data?.domains ?? []).filter(
    (d) => (d.allowedKinds & (grantByDomain.get(d.id) ?? 0)) !== 0,
  );

  return (
    <Section title="Mailboxes" description="Mailboxes you own or have been granted access to.">
      <ul className="divide-y rounded-md border">
        {(mailboxesQ.data?.mailboxes ?? []).map((m) => (
          <MailboxRow key={m.id} mailbox={m} />
        ))}
        {mailboxesQ.data?.mailboxes.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-muted-foreground">
            No mailboxes yet.
          </li>
        )}
      </ul>
      <div className="mt-4 border-t pt-4">
        {eligibleDomains.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No domains available to you. Ask an administrator for a grant.
          </p>
        ) : (
          <CreateMailboxForm
            eligibleDomains={eligibleDomains}
            allowedKindsFor={(d) => d.allowedKinds & (grantByDomain.get(d.id) ?? 0)}
            onCreated={() => qc.invalidateQueries({ queryKey: ["mailboxes"] })}
          />
        )}
      </div>
    </Section>
  );
}

// Admin: one combined list of every mailbox and redirect, plus a create form
// that toggles between the two.
function AdminMailboxes({ meId }: { meId: string }) {
  const qc = useQueryClient();
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const usersQ = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api<{ users: AdminUser[] }>("/api/users"),
  });
  const mailboxesQ = useQuery({
    queryKey: ["admin-mailboxes"],
    queryFn: () => api<{ mailboxes: AdminMailbox[] }>("/api/admin/mailboxes"),
  });
  const redirectsQ = useQuery({
    queryKey: ["admin-redirects"],
    queryFn: () => api<{ redirects: RedirectRow[] }>("/api/admin/redirects"),
  });
  // Owned mailboxes carry permission bits; used to enable group member management.
  const ownQ = useQuery(mailboxesQuery);
  const ownById = new Map((ownQ.data?.mailboxes ?? []).map((m) => [m.id, m]));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
    qc.invalidateQueries({ queryKey: ["admin-redirects"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };

  const mailboxes = mailboxesQ.data?.mailboxes ?? [];
  const redirects = redirectsQ.data?.redirects ?? [];

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<
    "all" | "personal" | "group" | "service" | "temp" | "redirect"
  >("all");
  const [sort, setSort] = useState<"address" | "address-desc" | "type">("address");

  const allEntries: Entry[] = [
    ...mailboxes.map((mb): Entry => ({ kind: "mailbox", address: mb.address, mb })),
    ...redirects.map((rd): Entry => ({ kind: "redirect", address: rd.address, rd })),
  ];
  const total = allEntries.length;

  const q = query.trim().toLowerCase();
  const entries = allEntries
    .filter((e) => kindFilter === "all" || kindOf(e) === kindFilter)
    .filter((e) => {
      if (!q) return true;
      if (e.kind === "redirect")
        return e.address.toLowerCase().includes(q) || e.rd.targetAddress.toLowerCase().includes(q);
      return [e.address, e.mb.displayName, e.mb.ownerEmail, e.mb.ownerName].some((v) =>
        v?.toLowerCase().includes(q),
      );
    })
    .toSorted((a, b) => {
      if (sort === "address-desc") return b.address.localeCompare(a.address);
      if (sort === "type") {
        const t = kindOf(a).localeCompare(kindOf(b));
        return t !== 0 ? t : a.address.localeCompare(b.address);
      }
      return a.address.localeCompare(b.address);
    });

  const eligibleDomains = (domainsQ.data?.domains ?? []).filter((d) => d.allowedKinds !== 0);

  return (
    <Section
      title="Mailboxes & redirects"
      description={
        <>
          Every mailbox and inbound redirect in this deployment. A redirect is an inbound-only alias
          — mail to it lands in the target mailbox; it can't send. A catch-all <Mono>*@domain</Mono>{" "}
          receives anything with no matching mailbox or specific redirect.
        </>
      }
    >
      {total > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search address or owner…"
            className="h-8 min-w-[12rem] flex-1 text-[13px]"
          />
          <Select
            value={kindFilter}
            onValueChange={(v) => setKindFilter(v as typeof kindFilter)}
            className="h-8 w-auto text-[13px]"
            ariaLabel="Filter by kind"
            options={[
              { value: "all", label: "All kinds" },
              { value: "personal", label: "Personal" },
              { value: "group", label: "Group" },
              { value: "service", label: "Service" },
              { value: "temp", label: "Temp" },
              { value: "redirect", label: "Redirect" },
            ]}
          />
          <Select
            value={sort}
            onValueChange={(v) => setSort(v as typeof sort)}
            className="h-8 w-auto text-[13px]"
            ariaLabel="Sort"
            options={[
              { value: "address", label: "Address A–Z" },
              { value: "address-desc", label: "Address Z–A" },
              { value: "type", label: "Kind" },
            ]}
          />
          <span className="text-[12px] text-muted-foreground">
            {entries.length === total ? total : `${entries.length} / ${total}`}
          </span>
        </div>
      )}
      <ul className="divide-y rounded-md border">
        {entries.map((e) =>
          e.kind === "mailbox" ? (
            <AdminMailboxRow
              key={`m:${e.mb.id}`}
              mailbox={e.mb}
              users={usersQ.data?.users ?? []}
              allMailboxes={mailboxes}
              manageable={(() => {
                const own = ownById.get(e.mb.id);
                return own?.type === "group" && has(own.perms, Perm.MANAGE);
              })()}
              invalidate={invalidate}
            />
          ) : (
            <RedirectRow
              key={`r:${e.rd.id}`}
              redirect={e.rd}
              allMailboxes={mailboxes}
              invalidate={invalidate}
            />
          ),
        )}
        {entries.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-muted-foreground">
            {total === 0 ? "No mailboxes or redirects yet." : "No matches."}
          </li>
        )}
      </ul>

      <div className="mt-4 border-t pt-4">
        {eligibleDomains.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            Add a domain and enable at least one mailbox kind to create mailboxes here.
          </p>
        ) : (
          <AdminCreateForm
            meId={meId}
            eligibleDomains={eligibleDomains}
            allDomains={domainsQ.data?.domains ?? []}
            users={usersQ.data?.users ?? []}
            mailboxes={mailboxes}
            onCreated={invalidate}
          />
        )}
      </div>
    </Section>
  );
}

// Shared mailbox-creation row (local-part @ domain · type), used by non-admins.
function CreateMailboxForm({
  eligibleDomains,
  allowedKindsFor,
  onCreated,
}: {
  eligibleDomains: Domain[];
  allowedKindsFor: (d: Domain) => number;
  onCreated: () => void;
}) {
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState("");
  const [type, setType] = useState<MailboxSummary["type"]>("personal");

  const dom = eligibleDomains.find((d) => d.id === domain);
  const kinds = dom ? allowedKindsFor(dom) : 0;
  const typeOptions = KIND_CHECKBOXES.filter((k) => (kinds & k.bit) === k.bit);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/mailboxes", {
        method: "POST",
        body: JSON.stringify({ domainId: domain, localPart: local, type }),
      }),
    onSuccess: () => {
      setLocal("");
      onCreated();
      toast.success("Mailbox created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder="local-part"
        className="min-w-[140px] flex-1"
      />
      <span className="text-[13px] text-muted-foreground">@</span>
      <Select
        value={domain}
        onValueChange={(v) => {
          setDomain(v);
          const d = eligibleDomains.find((x) => x.id === v);
          const first = d && KIND_CHECKBOXES.find((k) => (allowedKindsFor(d) & k.bit) === k.bit);
          if (first) setType(first.type);
        }}
        className="min-w-[160px] flex-1"
        placeholder="Select domain…"
        ariaLabel="Domain"
        options={eligibleDomains.map((d) => ({ value: d.id, label: d.name }))}
      />
      <Select
        value={typeOptions.length === 0 ? "" : type}
        onValueChange={(v) => setType(v as MailboxSummary["type"])}
        disabled={typeOptions.length === 0}
        className="min-w-[110px]"
        placeholder="type"
        ariaLabel="Mailbox kind"
        options={typeOptions.map((k) => ({ value: k.type, label: k.label }))}
      />
      <PrimaryBtn onClick={() => create.mutate()} disabled={!domain || !local || create.isPending}>
        Add mailbox
      </PrimaryBtn>
    </div>
  );
}

// Admin create form: toggle between creating a mailbox or a redirect.
function AdminCreateForm({
  meId,
  eligibleDomains,
  allDomains,
  users,
  mailboxes,
  onCreated,
}: {
  meId: string;
  eligibleDomains: Domain[];
  allDomains: Domain[];
  users: AdminUser[];
  mailboxes: AdminMailbox[];
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<"mailbox" | "redirect">("mailbox");

  // Mailbox fields
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState("");
  const [type, setType] = useState<MailboxSummary["type"]>("personal");
  const [owner, setOwner] = useState("");
  const ownerId = owner || meId;

  // Redirect fields
  const [rLocal, setRLocal] = useState("");
  const [rDomain, setRDomain] = useState("");
  const [target, setTarget] = useState("");
  const [rCatchAll, setRCatchAll] = useState(false);
  const catchAllId = useId();
  const effLocal = rCatchAll ? "*" : rLocal;

  const dom = eligibleDomains.find((d) => d.id === domain);
  const typeOptions = KIND_CHECKBOXES.filter((k) => dom && (dom.allowedKinds & k.bit) === k.bit);
  const redirectTargets = mailboxes.filter((m) => m.type !== "temp" && m.type !== "service");

  const createMailbox = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/admin/mailboxes", {
        method: "POST",
        body: JSON.stringify({ domainId: domain, localPart: local, type, ownerUserId: ownerId }),
      }),
    onSuccess: () => {
      setLocal("");
      onCreated();
      toast.success("Mailbox created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const createRedirect = useMutation({
    mutationFn: () =>
      api("/api/admin/redirects", {
        method: "POST",
        body: JSON.stringify({ domainId: rDomain, localPart: effLocal, targetMailboxId: target }),
      }),
    onSuccess: () => {
      setRLocal("");
      setRCatchAll(false);
      onCreated();
      toast.success("Redirect created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-md border p-0.5 text-[12px]">
        <button
          type="button"
          onClick={() => setMode("mailbox")}
          className={cn(
            "rounded px-3 py-1 font-medium transition",
            mode === "mailbox"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          New mailbox
        </button>
        <button
          type="button"
          onClick={() => setMode("redirect")}
          className={cn(
            "rounded px-3 py-1 font-medium transition",
            mode === "redirect"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          New redirect
        </button>
      </div>

      {mode === "mailbox" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            placeholder="local-part"
            className="min-w-[140px] flex-1"
          />
          <span className="text-[13px] text-muted-foreground">@</span>
          <Select
            value={domain}
            onValueChange={(v) => {
              setDomain(v);
              const d = eligibleDomains.find((x) => x.id === v);
              const first = d && KIND_CHECKBOXES.find((k) => (d.allowedKinds & k.bit) === k.bit);
              if (first) setType(first.type);
            }}
            className="min-w-[160px] flex-1"
            placeholder="Select domain…"
            ariaLabel="Domain"
            options={eligibleDomains.map((d) => ({ value: d.id, label: d.name }))}
          />
          <Select
            value={typeOptions.length === 0 ? "" : type}
            onValueChange={(v) => setType(v as MailboxSummary["type"])}
            disabled={typeOptions.length === 0}
            className="w-auto min-w-[120px]"
            title="Mailbox kind"
            ariaLabel="Mailbox kind"
            placeholder="Type…"
            options={typeOptions.map((k) => ({
              value: k.type,
              label: k.label.charAt(0).toUpperCase() + k.label.slice(1),
            }))}
          />
          <Select
            value={ownerId}
            onValueChange={setOwner}
            title="Owner"
            ariaLabel="Owner"
            className="w-auto min-w-[160px]"
            options={users.map((u) => ({
              value: u.id,
              label: `${u.email}${u.id === meId ? " (you)" : ""}`,
            }))}
          />
          <PrimaryBtn
            onClick={() => createMailbox.mutate()}
            disabled={!domain || !local || !ownerId || createMailbox.isPending}
          >
            Add mailbox
          </PrimaryBtn>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={rCatchAll ? "*" : rLocal}
            onChange={(e) => setRLocal(e.target.value)}
            placeholder="local-part"
            disabled={rCatchAll}
            className="min-w-[120px] flex-1"
          />
          <label
            htmlFor={catchAllId}
            className="flex cursor-pointer items-center gap-1.5 text-[13px] text-muted-foreground select-none"
          >
            <Checkbox
              id={catchAllId}
              checked={rCatchAll}
              onCheckedChange={setRCatchAll}
              className="size-3.5"
            />
            catch-all
          </label>
          <span className="text-[13px] text-muted-foreground">@</span>
          <Select
            value={rDomain}
            onValueChange={setRDomain}
            className="min-w-[150px] flex-1"
            placeholder="Select domain…"
            ariaLabel="Domain"
            options={allDomains.map((d) => ({ value: d.id, label: d.name }))}
          />
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Select
            value={target}
            onValueChange={setTarget}
            className="min-w-[150px] flex-1"
            placeholder="Target mailbox…"
            ariaLabel="Target mailbox"
            options={redirectTargets.map((m) => ({ value: m.id, label: m.address }))}
          />
          <PrimaryBtn
            onClick={() => createRedirect.mutate()}
            disabled={!rDomain || !effLocal || !target || createRedirect.isPending}
          >
            Add redirect
          </PrimaryBtn>
        </div>
      )}
    </div>
  );
}

function RedirectRow({
  redirect: rd,
  allMailboxes,
  invalidate,
}: {
  redirect: RedirectRow;
  allMailboxes: AdminMailbox[];
  invalidate: () => void;
}) {
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [target, setTarget] = useState(rd.targetMailboxId);
  const { confirmDelete } = useConfirmHelpers();

  const migrate = useMutation({
    mutationFn: () =>
      api(`/api/admin/redirects/${rd.id}`, {
        method: "PATCH",
        body: JSON.stringify({ targetMailboxId: target }),
      }),
    onSuccess: () => {
      setMigrateOpen(false);
      invalidate();
      toast.success("Redirect re-pointed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/admin/redirects/${rd.id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast.success("Redirect removed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const targets = allMailboxes.filter((m) => m.type !== "temp" && m.type !== "service");

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{rd.address}</span>
            <KindBadge kind="redirect" />
          </div>
          <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <ArrowRight className="h-3 w-3 shrink-0" />
            {rd.targetAddress}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <GhostBtn
            onClick={() => {
              setTarget(rd.targetMailboxId);
              setMigrateOpen((v) => !v);
            }}
          >
            Migrate
          </GhostBtn>
          <GhostBtn
            destructive
            onClick={async () => {
              if (
                await confirmDelete(
                  `redirect ${rd.address}`,
                  "Mail to this address stops being forwarded.",
                )
              )
                remove.mutate();
            }}
          >
            Remove
          </GhostBtn>
        </div>
      </div>

      {migrateOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
          <span className="text-[11px] text-muted-foreground">New target</span>
          <Select
            value={target}
            onValueChange={setTarget}
            className="flex-1"
            ariaLabel="New target"
            options={targets.map((t) => ({ value: t.id, label: t.address }))}
          />
          <PrimaryBtn
            onClick={() => migrate.mutate()}
            disabled={target === rd.targetMailboxId || migrate.isPending}
          >
            Migrate
          </PrimaryBtn>
        </div>
      )}
    </li>
  );
}

function AdminMailboxRow({
  mailbox: m,
  users,
  allMailboxes,
  manageable,
  invalidate,
}: {
  mailbox: AdminMailbox;
  users: AdminUser[];
  allMailboxes: AdminMailbox[];
  manageable: boolean;
  invalidate: () => void;
}) {
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOwner, setNewOwner] = useState(m.ownerUserId);
  const [newType, setNewType] = useState(m.type);
  const [redirectTo, setRedirectTo] = useState("");

  // Only personal⇄group are interchangeable; temp/service have no type toggle.
  const canRetype = m.type === "personal" || m.type === "group";
  const ownerChanged = newOwner !== m.ownerUserId;
  const typeChanged = canRetype && newType !== m.type;

  const migrate = useMutation({
    mutationFn: () =>
      api(`/api/admin/mailboxes/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(ownerChanged ? { ownerUserId: newOwner } : {}),
          ...(typeChanged ? { type: newType } : {}),
        }),
      }),
    onSuccess: () => {
      setMigrateOpen(false);
      invalidate();
      toast.success(
        ownerChanged && typeChanged
          ? "Mailbox migrated"
          : typeChanged
            ? "Type changed"
            : "Owner changed",
      );
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/admin/mailboxes/${m.id}`, {
        method: "DELETE",
        body: JSON.stringify(redirectTo ? { redirectToMailboxId: redirectTo } : {}),
      }),
    onSuccess: () => {
      setDeleteOpen(false);
      invalidate();
      toast.success(redirectTo ? "Mailbox deleted, redirect created" : "Mailbox deleted");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const redirectTargets = allMailboxes.filter(
    (x) => x.id !== m.id && x.type !== "temp" && x.type !== "service",
  );

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{m.address}</span>
            <KindBadge kind={m.type} />
          </div>
          <div className="truncate text-[11px] text-muted-foreground">owner {m.ownerEmail}</div>
        </div>
        <div className="flex items-center gap-2">
          {manageable && (
            <GhostBtn
              onClick={() => {
                setMembersOpen((v) => !v);
                setMigrateOpen(false);
                setDeleteOpen(false);
                setSettingsOpen(false);
              }}
            >
              {membersOpen ? "Hide members" : "Members"}
            </GhostBtn>
          )}
          {m.type !== "temp" && (
            <GhostBtn
              onClick={() => {
                setSettingsOpen((v) => !v);
                setMigrateOpen(false);
                setDeleteOpen(false);
                setMembersOpen(false);
              }}
            >
              {settingsOpen ? "Hide settings" : "Settings"}
            </GhostBtn>
          )}
          <GhostBtn
            onClick={() => {
              setNewOwner(m.ownerUserId);
              setNewType(m.type);
              setMigrateOpen((v) => !v);
              setDeleteOpen(false);
              setMembersOpen(false);
              setSettingsOpen(false);
            }}
          >
            Migrate
          </GhostBtn>
          <GhostBtn
            destructive
            onClick={() => {
              setRedirectTo("");
              setDeleteOpen(true);
              setMigrateOpen(false);
              setMembersOpen(false);
              setSettingsOpen(false);
            }}
          >
            Delete
          </GhostBtn>
        </div>
      </div>

      {membersOpen && <MembersPanel mailboxId={m.id} />}

      {settingsOpen && (
        <div className="mt-3">
          <MailboxSettingsForm mailboxId={m.id} address={m.address} type={m.type} admin />
        </div>
      )}

      {migrateOpen && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-[11px] text-muted-foreground">Owner</span>
            <Select
              value={newOwner}
              onValueChange={setNewOwner}
              className="flex-1"
              ariaLabel="Owner"
              options={users.map((u) => ({ value: u.id, label: u.email }))}
            />
          </div>
          {canRetype && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-16 text-[11px] text-muted-foreground">Type</span>
              <Select
                value={newType}
                onValueChange={(v) => setNewType(v as AdminMailbox["type"])}
                className="flex-1"
                ariaLabel="Type"
                options={[
                  { value: "personal", label: "personal" },
                  { value: "group", label: "group" },
                ]}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {typeChanged && newType === "personal"
                ? "Switching to personal removes shared members."
                : ""}
            </span>
            <PrimaryBtn
              onClick={() => migrate.mutate()}
              disabled={(!ownerChanged && !typeChanged) || migrate.isPending}
            >
              Migrate
            </PrimaryBtn>
          </div>
        </div>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {m.address}?</DialogTitle>
            <DialogDescription>
              Optionally keep receiving mail sent to this address by redirecting it to another
              mailbox. Otherwise the mailbox and its messages are removed permanently.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-[11px]">
            <span className="text-muted-foreground">Redirect inbound mail</span>
            <Select
              ariaLabel="Redirect inbound mail"
              value={redirectTo}
              onValueChange={setRedirectTo}
              options={[
                { value: "", label: "No redirect — delete permanently" },
                ...redirectTargets.map((t) => ({ value: t.id, label: `→ ${t.address}` })),
              ]}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Deleting…" : redirectTo ? "Delete + redirect" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function MailboxRow({ mailbox: m }: { mailbox: MailboxSummary }) {
  const canManage = m.type === "group" && has(m.perms, Perm.MANAGE);
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{m.address}</span>
            <KindBadge kind={m.type} />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {m.role}
            {m.expiresAt && ` · expires ${new Date(m.expiresAt).toLocaleString()}`}
          </div>
        </div>
        {canManage && (
          <GhostBtn onClick={() => setOpen((v) => !v)}>
            {open ? "Hide members" : "Members"}
          </GhostBtn>
        )}
      </div>
      {canManage && open && <MembersPanel mailboxId={m.id} />}
    </li>
  );
}

interface Invite {
  id: string;
  email: string;
  perms: number;
  createdAt: string;
}

function MembersPanel({ mailboxId }: { mailboxId: string }) {
  const qc = useQueryClient();
  const { confirm } = useConfirmHelpers();
  const membersQ = useQuery({
    queryKey: ["mailbox-members", mailboxId],
    queryFn: () => api<{ members: Member[] }>(`/api/mailboxes/${mailboxId}/members`),
  });
  const invitesQ = useQuery({
    queryKey: ["mailbox-invites", mailboxId],
    queryFn: () => api<{ invites: Invite[] }>(`/api/mailboxes/${mailboxId}/invites`),
  });

  const directoryQ = useQuery({
    queryKey: ["user-directory"],
    queryFn: () => api<{ users: DirectoryUser[] }>("/api/users/directory"),
  });

  const [selectedUserId, setSelectedUserId] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [manage, setManage] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["mailbox-members", mailboxId] });
    qc.invalidateQueries({ queryKey: ["mailbox-invites", mailboxId] });
  };

  const memberIds = new Set((membersQ.data?.members ?? []).map((m) => m.userId));
  const candidates = (directoryQ.data?.users ?? []).filter((u) => !memberIds.has(u.id));

  const addMember = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/api/mailboxes/${mailboxId}/members`, {
        method: "POST",
        body: JSON.stringify({ mailboxId, userId: selectedUserId, read, write, manage }),
      }),
    onSuccess: () => {
      setSelectedUserId("");
      setRead(true);
      setWrite(false);
      setManage(false);
      invalidate();
      toast.success("Member added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      api(`/api/mailboxes/${mailboxId}/invites/${inviteId}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const updatePerms = useMutation({
    mutationFn: ({ userId, perms }: { userId: string; perms: number }) =>
      api(`/api/mailboxes/${mailboxId}/members`, {
        method: "POST",
        body: JSON.stringify({
          mailboxId,
          userId,
          read: has(perms, Perm.READ),
          write: has(perms, Perm.WRITE),
          manage: has(perms, Perm.MANAGE),
        }),
      }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/mailboxes/${mailboxId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const toggle = (member: Member, bit: PermBit) => {
    const next = has(member.perms, bit) ? member.perms & ~bit : member.perms | bit;
    updatePerms.mutate({ userId: member.userId, perms: next });
  };

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Members
      </div>
      <ul className="mb-3 divide-y rounded-md border bg-card">
        {(membersQ.data?.members ?? []).map((member) => (
          <li
            key={member.userId}
            className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]"
          >
            <div className="min-w-0 flex-1 truncate">
              <div className="truncate font-medium">{member.email}</div>
              {member.name && (
                <div className="truncate text-[11px] text-muted-foreground">{member.name}</div>
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <PermToggle
                label="read"
                checked={has(member.perms, Perm.READ)}
                onChange={() => toggle(member, Perm.READ)}
              />
              <PermToggle
                label="write"
                checked={has(member.perms, Perm.WRITE)}
                onChange={() => toggle(member, Perm.WRITE)}
              />
              <PermToggle
                label="manage"
                checked={has(member.perms, Perm.MANAGE)}
                onChange={() => toggle(member, Perm.MANAGE)}
              />
              <GhostBtn
                destructive
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Remove ${member.email}?`,
                      description: "They lose access to this mailbox immediately.",
                      confirmLabel: "Remove",
                      destructive: true,
                    })
                  )
                    removeMember.mutate(member.userId);
                }}
              >
                Remove
              </GhostBtn>
            </div>
          </li>
        ))}
        {membersQ.data?.members.length === 0 &&
          (!invitesQ.data || invitesQ.data.invites.length === 0) && (
            <li className="px-3 py-4 text-center text-[11px] text-muted-foreground">
              No members yet.
            </li>
          )}
        {(invitesQ.data?.invites ?? []).map((inv) => (
          <li
            key={inv.id}
            className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]"
          >
            <div className="min-w-0 flex-1 truncate">
              <div className="truncate font-medium text-muted-foreground">
                {inv.email} <span className="text-[11px]">(pending)</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                Invite sent {new Date(inv.createdAt).toLocaleString()} · {permLabel(inv.perms)}
              </div>
            </div>
            <GhostBtn
              destructive
              onClick={async () => {
                if (
                  await confirm({
                    title: `Revoke invite for ${inv.email}?`,
                    description: "The invite stops working immediately.",
                    confirmLabel: "Revoke",
                    destructive: true,
                  })
                )
                  removeInvite.mutate(inv.id);
              }}
            >
              Revoke
            </GhostBtn>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selectedUserId}
          onValueChange={setSelectedUserId}
          className="min-w-[200px] flex-1"
          disabled={directoryQ.isLoading}
          ariaLabel="User"
          placeholder={candidates.length === 0 ? "No users available" : "Select a user…"}
          options={candidates.map((u) => ({
            value: u.id,
            label: u.name ? `${u.name} (${u.email})` : u.email,
          }))}
        />
        <div className="flex items-center gap-2 text-[11px]">
          <PermToggle label="read" checked={read} onChange={() => setRead((v) => !v)} />
          <PermToggle label="write" checked={write} onChange={() => setWrite((v) => !v)} />
          <PermToggle label="manage" checked={manage} onChange={() => setManage((v) => !v)} />
        </div>
        <PrimaryBtn
          onClick={() => addMember.mutate()}
          disabled={!selectedUserId || addMember.isPending}
        >
          Add
        </PrimaryBtn>
      </div>
    </div>
  );
}

function permLabel(perms: number): string {
  const out: string[] = [];
  if (has(perms, Perm.READ)) out.push("read");
  if (has(perms, Perm.WRITE)) out.push("write");
  if (has(perms, Perm.MANAGE)) out.push("manage");
  return out.length ? out.join(", ") : "no permissions";
}

function PermToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-1.5 select-none">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} className="size-3.5" />
      {label}
    </label>
  );
}

// ─── Blocking ─────────────────────────────────────────────────────────────────

interface BlockEntry {
  id: string;
  type: "email" | "domain";
  value: string;
  reason: string | null;
  createdAt: string;
  createdByName: string | null;
}

interface BlockReq {
  id: string;
  type: "email" | "domain";
  value: string;
  fromName: string | null;
  subject: string | null;
  note: string | null;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  reviewedAt: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
}

function BlockingSection() {
  return (
    <div className="space-y-5">
      <BlockRequestsPanel />
      <BlocklistPanel />
      <ProtectedDomainsPanel />
    </div>
  );
}

function BlockRequestsPanel() {
  const qc = useQueryClient();
  const reqs = useQuery({
    queryKey: ["admin-block-requests"],
    queryFn: () => api<{ requests: BlockReq[] }>("/api/admin/block/requests"),
  });
  const all = reqs.data?.requests ?? [];
  const pending = all.filter((r) => r.status === "pending");
  const reviewed = all.filter((r) => r.status !== "pending");

  const act = (path: string, method: "POST" | "DELETE") =>
    api(path, { method }).then(() => {
      qc.invalidateQueries({ queryKey: ["admin-block-requests"] });
      qc.invalidateQueries({ queryKey: ["admin-blocklist"] });
    });

  return (
    <Section
      title="Block requests"
      description={
        <>
          Requests from readers to block a sender. Approving adds the address to the blocklist so
          its mail is rejected going forward.
        </>
      }
    >
      {pending.length === 0 && reviewed.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No requests yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {[...pending, ...reviewed].map((req) => (
            <BlockRequestRow key={req.id} req={req} act={act} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function BlockRequestRow({
  req,
  act,
}: {
  req: BlockReq;
  act: (path: string, method: "POST" | "DELETE") => Promise<unknown>;
}) {
  const { confirm } = useConfirmHelpers();
  const run = (path: string, method: "POST" | "DELETE", ok: string) =>
    act(path, method)
      .then(() => toast.success(ok))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"));

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{req.value}</span>
            {req.status !== "pending" && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {req.status}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {req.subject ? `“${req.subject}” · ` : ""}
            requested by {req.requestedByName ?? req.requestedByEmail ?? "unknown"}
            {req.note ? ` · ${req.note}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {req.status === "pending" && (
            <>
              <GhostBtn
                onClick={() =>
                  run(`/api/admin/block/requests/${req.id}/approve`, "POST", "Sender blocked")
                }
              >
                <Check className="h-3.5 w-3.5" /> Approve
              </GhostBtn>
              <GhostBtn
                onClick={() =>
                  run(`/api/admin/block/requests/${req.id}/deny`, "POST", "Request denied")
                }
              >
                <X className="h-3.5 w-3.5" /> Deny
              </GhostBtn>
            </>
          )}
          <GhostBtn
            destructive
            onClick={async () => {
              if (
                await confirm({
                  title: "Delete this block request?",
                  confirmLabel: "Delete",
                  destructive: true,
                })
              )
                run(`/api/admin/block/requests/${req.id}`, "DELETE", "Removed");
            }}
          >
            Delete
          </GhostBtn>
        </div>
      </div>
    </li>
  );
}

function BlocklistPanel() {
  const qc = useQueryClient();
  const entries = useQuery({
    queryKey: ["admin-blocklist"],
    queryFn: () => api<{ entries: BlockEntry[] }>("/api/admin/block/entries"),
  });
  const [type, setType] = useState<"email" | "domain">("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api("/api/admin/block/entries", {
        method: "POST",
        body: JSON.stringify({ type, value: value.trim(), reason: reason.trim() || undefined }),
      }),
    onSuccess: () => {
      setValue("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["admin-blocklist"] });
      toast.success("Added to blocklist");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Section
      title="Blocklist"
      description="Senders here are rejected at intake — never delivered. Mail bounces look like an unknown address, so the sender isn't told they're blocked."
    >
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) add.mutate();
        }}
      >
        <Select
          value={type}
          onValueChange={(v) => setType(v as "email" | "domain")}
          className="w-28"
          ariaLabel="Block type"
          options={[
            { value: "email", label: "email" },
            { value: "domain", label: "domain" },
          ]}
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={type === "email" ? "spammer@example.com" : "example.com"}
          className="min-w-52 flex-1"
        />
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (optional)"
          className="min-w-40 flex-1"
        />
        <PrimaryBtn type="submit" disabled={add.isPending || !value.trim()}>
          Add
        </PrimaryBtn>
      </form>

      {(entries.data?.entries.length ?? 0) === 0 ? (
        <p className="text-[12px] text-muted-foreground">Nothing blocked.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {(entries.data?.entries ?? []).map((entry) => (
            <BlockEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function BlockEntryRow({ entry }: { entry: BlockEntry }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => api(`/api/admin/block/entries/${entry.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-blocklist"] });
      toast.success("Unblocked");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {entry.type}
            </span>
            <span className="truncate font-medium">{entry.value}</span>
          </div>
          {entry.reason && (
            <div className="truncate text-[11px] text-muted-foreground">{entry.reason}</div>
          )}
        </div>
        <GhostBtn
          destructive
          disabled={remove.isPending}
          onClick={async () => {
            if (await confirm({ title: `Unblock ${entry.value}?` })) remove.mutate();
          }}
        >
          Unblock
        </GhostBtn>
      </div>
    </li>
  );
}

// Strip a leading @ / mailto and lowercase; reject anything without a dot.
function normalizeDomain(raw: string): string | null {
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^mailto:/, "");
  return d.includes(".") ? d : null;
}

function ProtectedDomainsPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-protected-domains"],
    queryFn: () => api<{ domains: string[] }>("/api/admin/block/protected-domains"),
  });
  // null = untouched (mirrors the server value); an array once edited locally.
  const [draft, setDraft] = useState<string[] | null>(null);
  const current = q.data?.domains ?? [];
  const domains = draft ?? current;
  const dirty = draft !== null;

  const save = useMutation({
    mutationFn: () =>
      api("/api/admin/block/protected-domains", {
        method: "PUT",
        body: JSON.stringify({ domains }),
      }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["admin-protected-domains"] });
      toast.success("Protected domains saved");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Section
      title="Protected domains"
      description="These domains can never be blocked wholesale — only individual addresses on them."
    >
      <TokenField
        value={domains}
        onChange={setDraft}
        ariaLabel="Protected domains"
        placeholder="gmail.com, proton.me…"
        normalize={normalizeDomain}
      />
      <div className="mt-3 flex justify-end gap-2">
        <GhostBtn disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
          Reset
        </GhostBtn>
        <PrimaryBtn disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save
        </PrimaryBtn>
      </div>
    </Section>
  );
}
