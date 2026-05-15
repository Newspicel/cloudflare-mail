import { has, Perm, type PermBit } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { type MailboxSummary, mailboxesQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/admin")({
  component: AdminPage,
});

interface Domain {
  id: string;
  name: string;
  kind: "primary" | "sub";
  isTempDomain: boolean;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  lastCheckedAt: string | null;
}

interface Member {
  userId: string;
  email: string;
  name: string;
  perms: number;
}

function AdminPage() {
  const qc = useQueryClient();

  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const mailboxesQ = useQuery(mailboxesQuery);

  const [newDomain, setNewDomain] = useState("");
  const [domainKind, setDomainKind] = useState<"primary" | "sub">("primary");

  const addDomain = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/domains", {
        method: "POST",
        body: JSON.stringify({ name: newDomain, kind: domainKind }),
      }),
    onSuccess: () => {
      setNewDomain("");
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("Domain added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [mbDomain, setMbDomain] = useState("");
  const [mbLocal, setMbLocal] = useState("");
  const [mbType, setMbType] = useState<"personal" | "group" | "service" | "temp">("personal");

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

  return (
    <div className="mx-auto max-w-4xl space-y-10 p-10">
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          Manage domains and mailboxes. Both must be backed by Cloudflare DNS with Email Routing
          enabled.
        </p>
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
        <div className="flex gap-2">
          <input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="example.com"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <select
            value={domainKind}
            onChange={(e) => setDomainKind(e.target.value as typeof domainKind)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="primary">primary</option>
            <option value="sub">sub</option>
          </select>
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

        <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2">
          <select
            value={mbDomain}
            onChange={(e) => setMbDomain(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">Select domain…</option>
            {(domainsQ.data?.domains ?? []).map((d) => (
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
            onChange={(e) => setMbType(e.target.value as typeof mbType)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="personal">personal</option>
            <option value="group">group</option>
            <option value="service">service</option>
            <option value="temp">temp</option>
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
      </section>
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
  const toggleTemp = useMutation({
    mutationFn: (isTempDomain: boolean) =>
      api(`/api/domains/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isTempDomain }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const checkedLabel = d.lastCheckedAt
    ? `checked ${new Date(d.lastCheckedAt).toLocaleString()}`
    : "not yet checked";
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium">{d.name}</div>
        <div className="text-xs text-muted-foreground">
          {d.kind}
          {d.isTempDomain && " · temp"} · {checkedLabel}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <DnsBadge label="SPF" ok={d.spfOk} checked={d.lastCheckedAt !== null} />
        <DnsBadge label="DKIM" ok={d.dkimOk} checked={d.lastCheckedAt !== null} />
        <DnsBadge label="DMARC" ok={d.dmarcOk} checked={d.lastCheckedAt !== null} />
        <label
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          title="Allow this domain to host temporary mailboxes"
        >
          <input
            type="checkbox"
            checked={d.isTempDomain}
            disabled={toggleTemp.isPending}
            onChange={(e) => toggleTemp.mutate(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          temp
        </label>
        <button
          type="button"
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending}
          className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {recheck.isPending ? "Checking…" : "Recheck"}
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
