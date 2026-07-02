import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  type AdminUser,
  KindCheckboxes,
  renderKinds,
  Section,
  Select,
} from "@/components/admin/shared.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirm, useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { Input } from "@/components/ui/input.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { meQuery } from "@/lib/queries.ts";

// The wire format carries `role` as a plain string.
type AdminUserRow = Omit<AdminUser, "role"> & { role: string };

interface UserInviteRow {
  id: string;
  email: string;
  role: "admin" | "user";
  expiresAt: string;
  usedAt: string | null;
}

export function UsersSection() {
  const qc = useQueryClient();
  const { data: usersData } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => unwrap(rpc.users.$get()),
  });
  const { data: invitesData } = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => unwrap(rpc.users.invites.$get()),
  });
  const pendingInvites = (invitesData?.invites ?? []).filter((i) => !i.usedAt);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "user">("user");
  const sendInvite = useMutation({
    mutationFn: () =>
      unwrap(rpc.users.invites.$post({ json: { email: inviteEmail, role: inviteRole } })),
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
      unwrap(
        rpc.users.$post({
          json: {
            email: createEmail,
            name: createName,
            password: createPassword,
            role: createRole,
          },
        }),
      ),
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
          {(usersData?.users ?? []).map((u) => (
            <UserRow key={u.id} user={u} />
          ))}
          {usersData?.users.length === 0 && (
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
          <Button
            variant="primary"
            onClick={() => sendInvite.mutate()}
            disabled={!inviteEmail || sendInvite.isPending}
          >
            Send invite
          </Button>
        </div>
        {pendingInvites.length > 0 && (
          <ul className="mt-4 divide-y rounded-md border">
            {pendingInvites.map((inv) => (
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
          <Button
            variant="primary"
            onClick={() => createUser.mutate()}
            disabled={
              !createEmail || !createName || createPassword.length < 8 || createUser.isPending
            }
          >
            Create user
          </Button>
        </div>
      </Section>
    </div>
  );
}

function UserRow({ user }: { user: AdminUserRow }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: meData } = useQuery(meQuery);
  const isMe = meData?.user?.id === user.id;
  const [open, setOpen] = useState(false);

  const setRole = useMutation({
    mutationFn: (role: "admin" | "user") =>
      unwrap(rpc.users[":id"].$patch({ param: { id: user.id }, json: { role } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: () => unwrap(rpc.users[":id"].$delete({ param: { id: user.id } })),
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
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Grants"}
          </Button>
          {!isMe && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
            </Button>
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
    mutationFn: () => unwrap(rpc.users.invites[":id"].$delete({ param: { id: invite.id } })),
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
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
      </Button>
    </li>
  );
}

function DomainGrantsPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: () => unwrap(rpc.domains.$get()),
  });
  const { data: grantsData } = useQuery({
    queryKey: ["user-grants", userId],
    queryFn: () => unwrap(rpc.users[":id"]["domain-grants"].$get({ param: { id: userId } })),
  });

  const setGrant = useMutation({
    mutationFn: ({ domainId, allowedKinds }: { domainId: string; allowedKinds: number }) =>
      unwrap(
        rpc.users[":id"]["domain-grants"][":domainId"].$put({
          param: { id: userId, domainId },
          json: { userId, allowedKinds },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-grants", userId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const grantByDomain = new Map(
    (grantsData?.grants ?? []).map((g) => [g.domainId, g.allowedKinds]),
  );

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Per-domain mailbox-kind grants
      </div>
      <ul className="divide-y rounded-md border bg-card">
        {(domainsData?.domains ?? []).map((d) => {
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
        {domainsData?.domains.length === 0 && (
          <li className="px-3 py-3 text-center text-[11px] text-muted-foreground">
            No domains configured.
          </li>
        )}
      </ul>
    </div>
  );
}
