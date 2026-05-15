import { has, MailboxKind, Perm, type PermBit } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { type MailboxSummary, mailboxesQuery, meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/admin")({
  component: AdminPage,
});

interface Domain {
  id: string;
  name: string;
  kind: "primary" | "sub";
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

type Tab = "domains" | "users" | "mailboxes";

function AdminPage() {
  const me = useQuery(meQuery);
  const isAdmin = me.data?.user?.role === "admin";
  const [tab, setTab] = useState<Tab>(isAdmin ? "domains" : "mailboxes");

  if (me.isLoading) {
    return <div className="p-8 text-[13px] text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-8 py-8">
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
          </div>
        )}

        {isAdmin && tab === "domains" && <DomainsSection />}
        {isAdmin && tab === "users" && <UsersSection />}
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

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "rounded-md border bg-background px-2.5 py-1.5 text-[13px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20",
        props.className,
      )}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20",
        props.className,
      )}
    />
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
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
    >
      {children}
    </button>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border px-2 py-1 text-[11px] font-medium transition disabled:opacity-50",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
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
  const [domainKind, setDomainKind] = useState<"primary" | "sub">("primary");
  const [newKinds, setNewKinds] = useState<number>(MailboxKind.PERSONAL);

  const addDomain = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/domains", {
        method: "POST",
        body: JSON.stringify({ name: newDomain, kind: domainKind, allowedKinds: newKinds }),
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
        description="From-address used for password reset and invitation emails. Must be on a verified Email Sending domain."
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

      <Section title="Domains" description="Verified mail domains and their allowed mailbox kinds.">
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-[13px]">
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
          <Select
            value={domainKind}
            onChange={(e) => setDomainKind(e.target.value as typeof domainKind)}
          >
            <option value="primary">primary</option>
            <option value="sub">sub</option>
          </Select>
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
  const toggle = (bit: number) => onChange((value & bit) === bit ? value & ~bit : value | bit);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {KIND_CHECKBOXES.map((k) => (
        <label key={k.label} className="flex cursor-pointer items-center gap-1 select-none">
          <input
            type="checkbox"
            checked={(value & k.bit) === k.bit}
            onChange={() => toggle(k.bit)}
            className="h-3 w-3 accent-primary"
          />
          {k.label}
        </label>
      ))}
    </div>
  );
}

function DomainRow({ domain: d }: { domain: Domain }) {
  const qc = useQueryClient();
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
        <div className="text-[11px] text-muted-foreground">
          {d.kind} · {checkedLabel}
        </div>
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
            onClick={() => {
              if (confirm(`Remove ${d.name}?`)) deleteDom.mutate();
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
      <Section title="Users" description="People with access to this deployment.">
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

      <Section
        title="Send invite"
        description="User sets their own password via a one-time link. Requires the transactional from-address to be configured."
      >
        <div className="flex flex-wrap gap-2">
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@example.com"
            className="min-w-[240px] flex-1"
          />
          <Select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </Select>
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
        description="Skip the invite flow — set the user's initial password yourself and share it out-of-band."
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
            onChange={(e) => setCreateRole(e.target.value as typeof createRole)}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </Select>
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
            onChange={(e) => setRole.mutate(e.target.value as "admin" | "user")}
            disabled={isMe || setRole.isPending}
            className="py-1 text-[11px]"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </Select>
          <GhostBtn onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Grants"}</GhostBtn>
          {!isMe && (
            <GhostBtn
              destructive
              onClick={() => {
                if (confirm(`Delete ${user.email}?`)) remove.mutate();
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
      <GhostBtn destructive onClick={() => revoke.mutate()}>
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

// ─── Mailboxes ──────────────────────────────────────────────────────────────

function MailboxesSection() {
  const qc = useQueryClient();
  const me = useQuery(meQuery);
  const isAdmin = me.data?.user?.role === "admin";

  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const mailboxesQ = useQuery(mailboxesQuery);
  const grantsQ = useQuery({
    queryKey: ["user-grants", me.data?.user?.id],
    queryFn: () =>
      api<{ grants: DomainGrantRow[] }>(`/api/users/${me.data?.user?.id}/domain-grants`),
    enabled: Boolean(me.data?.user?.id) && !isAdmin,
  });

  const [mbDomain, setMbDomain] = useState("");
  const [mbLocal, setMbLocal] = useState("");
  const [mbType, setMbType] = useState<MailboxSummary["type"]>("personal");

  const addMailbox = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/mailboxes", {
        method: "POST",
        body: JSON.stringify({ domainId: mbDomain, localPart: mbLocal, type: mbType }),
      }),
    onSuccess: () => {
      setMbLocal("");
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      toast.success("Mailbox created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const grantByDomain = new Map(
    (grantsQ.data?.grants ?? []).map((g) => [g.domainId, g.allowedKinds]),
  );

  function allowedKindsFor(d: Domain): number {
    if (isAdmin) return d.allowedKinds;
    const userGrant = grantByDomain.get(d.id) ?? 0;
    return d.allowedKinds & userGrant;
  }

  const eligibleDomains = (domainsQ.data?.domains ?? []).filter((d) => allowedKindsFor(d) !== 0);

  return (
    <div className="space-y-5">
      <Section title="Mailboxes">
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
              {isAdmin
                ? "Add a domain and enable at least one mailbox kind to create mailboxes here."
                : "No domains available to you. Ask an administrator for a grant."}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={mbDomain}
                onChange={(e) => {
                  setMbDomain(e.target.value);
                  const dom = eligibleDomains.find((d) => d.id === e.target.value);
                  if (dom) {
                    const kinds = allowedKindsFor(dom);
                    const first = KIND_CHECKBOXES.find((k) => (kinds & k.bit) === k.bit);
                    if (first) setMbType(first.type);
                  }
                }}
                className="min-w-[160px] flex-1"
              >
                <option value="">Select domain…</option>
                {eligibleDomains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <Input
                value={mbLocal}
                onChange={(e) => setMbLocal(e.target.value)}
                placeholder="local-part"
                className="min-w-[140px] flex-1"
              />
              <Select
                value={mbType}
                onChange={(e) => setMbType(e.target.value as MailboxSummary["type"])}
              >
                {(() => {
                  const dom = eligibleDomains.find((d) => d.id === mbDomain);
                  const kinds = dom ? allowedKindsFor(dom) : 0;
                  return KIND_CHECKBOXES.filter((k) => (kinds & k.bit) === k.bit).map((k) => (
                    <option key={k.label} value={k.type}>
                      {k.label}
                    </option>
                  ));
                })()}
              </Select>
              <PrimaryBtn
                onClick={() => addMailbox.mutate()}
                disabled={!mbDomain || !mbLocal || addMailbox.isPending}
              >
                Add mailbox
              </PrimaryBtn>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

function MailboxRow({ mailbox: m }: { mailbox: MailboxSummary }) {
  const canManage = m.type === "group" && has(m.perms, Perm.MANAGE);
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{m.address}</div>
          <div className="text-[11px] text-muted-foreground">
            {m.type} · {m.role}
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
  const membersQ = useQuery({
    queryKey: ["mailbox-members", mailboxId],
    queryFn: () => api<{ members: Member[] }>(`/api/mailboxes/${mailboxId}/members`),
  });
  const invitesQ = useQuery({
    queryKey: ["mailbox-invites", mailboxId],
    queryFn: () => api<{ invites: Invite[] }>(`/api/mailboxes/${mailboxId}/invites`),
  });

  const [email, setEmail] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [manage, setManage] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["mailbox-members", mailboxId] });
    qc.invalidateQueries({ queryKey: ["mailbox-invites", mailboxId] });
  };

  const addMember = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; invited?: boolean }>(`/api/mailboxes/${mailboxId}/members`, {
        method: "POST",
        body: JSON.stringify({ mailboxId, email, read, write, manage }),
      }),
    onSuccess: (res) => {
      setEmail("");
      setRead(true);
      setWrite(false);
      setManage(false);
      invalidate();
      toast.success(res.invited ? "Invite sent" : "Member added");
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
              <GhostBtn destructive onClick={() => removeMember.mutate(member.userId)}>
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
            <GhostBtn destructive onClick={() => removeInvite.mutate(inv.id)}>
              Revoke
            </GhostBtn>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          className="min-w-[200px] flex-1"
        />
        <div className="flex items-center gap-2 text-[11px]">
          <PermToggle label="read" checked={read} onChange={() => setRead((v) => !v)} />
          <PermToggle label="write" checked={write} onChange={() => setWrite((v) => !v)} />
          <PermToggle label="manage" checked={manage} onChange={() => setManage((v) => !v)} />
        </div>
        <PrimaryBtn onClick={() => addMember.mutate()} disabled={!email || addMember.isPending}>
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
  return (
    <label className="flex cursor-pointer items-center gap-1 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3 w-3 accent-primary"
      />
      {label}
    </label>
  );
}
