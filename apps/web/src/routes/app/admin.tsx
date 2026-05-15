import { has, MailboxKind, Perm, type PermBit } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
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

  if (me.isLoading) return <div className="p-10 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-10">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "Manage domains, users, and mailboxes."
            : "Mailboxes you own or have been granted access to."}
        </p>
      </section>

      {isAdmin && (
        <div className="flex gap-2 border-b">
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
  );
}

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
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
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
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-1 text-lg font-medium">Transactional email</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          From-address used for password reset and invitation emails. Must be on a verified Email
          Sending domain.
        </p>
        <div className="flex gap-2">
          <input
            value={fromAddr || settingsQ.data?.authFromAddress || ""}
            onChange={(e) => setFromAddr(e.target.value)}
            placeholder="noreply@example.com"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <button
            type="button"
            onClick={() => saveFrom.mutate()}
            disabled={!fromAddr || saveFrom.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-3 text-lg font-medium">Domains</h2>
        <ul className="mb-4 divide-y rounded-lg border">
          {(domainsQ.data?.domains ?? []).map((d) => (
            <DomainRow key={d.id} domain={d} />
          ))}
          {domainsQ.data?.domains.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">No domains yet.</li>
          )}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="example.com"
            className="min-w-[200px] flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <select
            value={domainKind}
            onChange={(e) => setDomainKind(e.target.value as typeof domainKind)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="primary">primary</option>
            <option value="sub">sub</option>
          </select>
          <KindCheckboxes value={newKinds} onChange={setNewKinds} />
          <button
            type="button"
            onClick={() => addDomain.mutate()}
            disabled={!newDomain || addDomain.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </section>
    </div>
  );
}

function KindCheckboxes({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const toggle = (bit: number) => onChange((value & bit) === bit ? value & ~bit : value | bit);
  return (
    <div className="flex items-center gap-2 text-xs">
      {KIND_CHECKBOXES.map((k) => (
        <label key={k.label} className="flex cursor-pointer items-center gap-1 select-none">
          <input
            type="checkbox"
            checked={(value & k.bit) === k.bit}
            onChange={() => toggle(k.bit)}
            className="h-3.5 w-3.5"
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
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium">{d.name}</div>
        <div className="text-xs text-muted-foreground">
          {d.kind} · {checkedLabel}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DnsBadge label="SPF" ok={d.spfOk} checked={d.lastCheckedAt !== null} />
        <DnsBadge label="DKIM" ok={d.dkimOk} checked={d.lastCheckedAt !== null} />
        <DnsBadge label="DMARC" ok={d.dmarcOk} checked={d.lastCheckedAt !== null} />
        <KindCheckboxes value={d.allowedKinds} onChange={(v) => setKinds.mutate(v)} />
        <button
          type="button"
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending}
          className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {recheck.isPending ? "Checking…" : "Recheck"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Remove ${d.name}?`)) deleteDom.mutate();
          }}
          className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function DnsBadge({ label, ok, checked }: { label: string; ok: boolean; checked: boolean }) {
  const cls = !checked
    ? "border-border bg-muted text-muted-foreground"
    : ok
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : "border-destructive/30 bg-destructive/10 text-destructive";
  const icon = !checked ? "·" : ok ? "✓" : "✗";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={
        !checked
          ? "Not yet checked"
          : ok
            ? `${label} record found`
            : `${label} record missing or invalid`
      }
    >
      <span>{icon}</span>
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
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-3 text-lg font-medium">Users</h2>
        <ul className="divide-y rounded-lg border">
          {(usersQ.data?.users ?? []).map((u) => (
            <UserRow key={u.id} user={u} />
          ))}
          {usersQ.data?.users.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No users yet.</li>
          )}
        </ul>
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-3 text-lg font-medium">Send invite</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          User sets their own password via a one-time link. Requires the transactional from-address
          to be configured.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@example.com"
            className="min-w-[240px] flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="button"
            onClick={() => sendInvite.mutate()}
            disabled={!inviteEmail || sendInvite.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Invite
          </button>
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
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-3 text-lg font-medium">Create user directly</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Skip the invite flow — set the user's initial password yourself and share it out-of-band.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Name"
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <input
            type="email"
            value={createEmail}
            onChange={(e) => setCreateEmail(e.target.value)}
            placeholder="user@example.com"
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <input
            type="password"
            minLength={8}
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Initial password"
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <select
            value={createRole}
            onChange={(e) => setCreateRole(e.target.value as typeof createRole)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => createUser.mutate()}
            disabled={
              !createEmail || !createName || createPassword.length < 8 || createUser.isPending
            }
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </section>
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
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={user.role}
            onChange={(e) => setRole.mutate(e.target.value as "admin" | "user")}
            disabled={isMe || setRole.isPending}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {open ? "Hide" : "Grants"}
          </button>
          {!isMe && (
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete ${user.email}?`)) remove.mutate();
              }}
              className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            >
              Delete
            </button>
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
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium text-muted-foreground">{invite.email}</div>
        <div className="text-xs text-muted-foreground">
          {invite.role} · expires {new Date(invite.expiresAt).toLocaleString()}
        </div>
      </div>
      <button
        type="button"
        onClick={() => revoke.mutate()}
        className="text-xs text-destructive hover:underline"
      >
        Revoke
      </button>
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
    <div className="mt-3 rounded-lg border bg-background p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        Per-domain mailbox-kind grants
      </div>
      <ul className="divide-y rounded-md border">
        {(domainsQ.data?.domains ?? []).map((d) => {
          const kinds = grantByDomain.get(d.id) ?? 0;
          return (
            <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1 truncate">
                <div className="truncate font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground">
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
          <li className="px-3 py-3 text-center text-xs text-muted-foreground">
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
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-3 text-lg font-medium">Mailboxes</h2>
        <ul className="mb-4 divide-y rounded-lg border">
          {(mailboxesQ.data?.mailboxes ?? []).map((m) => (
            <MailboxRow key={m.id} mailbox={m} />
          ))}
          {mailboxesQ.data?.mailboxes.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              No mailboxes yet.
            </li>
          )}
        </ul>

        {eligibleDomains.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {isAdmin
              ? "Add a domain and enable at least one mailbox kind to create mailboxes here."
              : "No domains available to you. Ask an administrator for a grant."}
          </p>
        ) : (
          <div className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
            <select
              value={mbDomain}
              onChange={(e) => {
                setMbDomain(e.target.value);
                // Reset type to a kind the user is allowed on this domain.
                const dom = eligibleDomains.find((d) => d.id === e.target.value);
                if (dom) {
                  const kinds = allowedKindsFor(dom);
                  const first = KIND_CHECKBOXES.find((k) => (kinds & k.bit) === k.bit);
                  if (first) setMbType(first.type);
                }
              }}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">Select domain…</option>
              {eligibleDomains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              value={mbLocal}
              onChange={(e) => setMbLocal(e.target.value)}
              placeholder="local-part"
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <select
              value={mbType}
              onChange={(e) => setMbType(e.target.value as MailboxSummary["type"])}
              className="rounded-md border bg-background px-3 py-2 text-sm"
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
            </select>
            <button
              type="button"
              onClick={() => addMailbox.mutate()}
              disabled={!mbDomain || !mbLocal || addMailbox.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function MailboxRow({ mailbox: m }: { mailbox: MailboxSummary }) {
  const canManage = m.type === "group" && has(m.perms, Perm.MANAGE);
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate font-medium">{m.address}</div>
          <div className="text-xs text-muted-foreground">
            {m.type} · {m.role}
            {m.expiresAt && ` · expires ${new Date(m.expiresAt).toLocaleString()}`}
          </div>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {open ? "Hide members" : "Members"}
          </button>
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
    <div className="mt-3 rounded-lg border bg-background p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">Members</div>
      <ul className="mb-3 divide-y rounded-md border">
        {(membersQ.data?.members ?? []).map((member) => (
          <li
            key={member.userId}
            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1 truncate">
              <div className="truncate font-medium">{member.email}</div>
              {member.name && (
                <div className="truncate text-xs text-muted-foreground">{member.name}</div>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs">
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
              <button
                type="button"
                onClick={() => removeMember.mutate(member.userId)}
                className="text-destructive hover:underline"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
        {membersQ.data?.members.length === 0 &&
          (!invitesQ.data || invitesQ.data.invites.length === 0) && (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">No members yet.</li>
          )}
        {(invitesQ.data?.invites ?? []).map((inv) => (
          <li key={inv.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1 truncate">
              <div className="truncate font-medium text-muted-foreground">
                {inv.email} <span className="text-xs">(pending)</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                Invite sent {new Date(inv.createdAt).toLocaleString()} · {permLabel(inv.perms)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => removeInvite.mutate(inv.id)}
              className="text-destructive hover:underline"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        <div className="flex items-center gap-2 text-xs">
          <PermToggle label="read" checked={read} onChange={() => setRead((v) => !v)} />
          <PermToggle label="write" checked={write} onChange={() => setWrite((v) => !v)} />
          <PermToggle label="manage" checked={manage} onChange={() => setManage((v) => !v)} />
        </div>
        <button
          type="button"
          onClick={() => addMember.mutate()}
          disabled={!email || addMember.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Add
        </button>
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
      <input type="checkbox" checked={checked} onChange={onChange} className="h-3.5 w-3.5" />
      {label}
    </label>
  );
}
