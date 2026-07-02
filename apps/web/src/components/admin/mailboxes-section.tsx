import { has, Perm, type PermBit } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  type AdminMailbox,
  type AdminUser,
  type Domain,
  KIND_CHECKBOXES,
  KindBadge,
  Mono,
  Section,
  Select,
} from "@/components/admin/shared.tsx";
import { MailboxSettingsForm } from "@/components/mailbox-settings-form.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ToggleGroup, ToggleItem } from "@/components/ui/toggle-group.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { type MailboxSummary, mailboxesQuery, meQuery } from "@/lib/queries.ts";

interface RedirectRow {
  id: string;
  address: string;
  targetMailboxId: string;
  targetAddress: string;
  createdAt: string;
}

interface Member {
  userId: string;
  email: string;
  name: string;
  perms: number;
}

type Entry =
  | { kind: "mailbox"; address: string; mb: AdminMailbox }
  | { kind: "redirect"; address: string; rd: RedirectRow };

const kindOf = (e: Entry) => (e.kind === "redirect" ? "redirect" : e.mb.type);

export function MailboxesSection() {
  const { data: meData } = useQuery(meQuery);
  const isAdmin = meData?.user?.role === "admin";
  return isAdmin ? <AdminMailboxes meId={meData?.user?.id ?? ""} /> : <OwnMailboxes />;
}

// Non-admin: only the mailboxes the user owns or was granted access to.
function OwnMailboxes() {
  const qc = useQueryClient();
  const { data: meData } = useQuery(meQuery);
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: () => unwrap(rpc.domains.$get()),
  });
  const { data: mailboxesData } = useQuery(mailboxesQuery);
  const { data: grantsData } = useQuery({
    queryKey: ["user-grants", meData?.user?.id],
    queryFn: () =>
      unwrap(rpc.users[":id"]["domain-grants"].$get({ param: { id: meData?.user?.id ?? "" } })),
    enabled: Boolean(meData?.user?.id),
  });

  const grantByDomain = new Map(
    (grantsData?.grants ?? []).map((g) => [g.domainId, g.allowedKinds]),
  );
  const eligibleDomains = (domainsData?.domains ?? []).filter(
    (d) => (d.allowedKinds & (grantByDomain.get(d.id) ?? 0)) !== 0,
  );

  return (
    <Section title="Mailboxes" description="Mailboxes you own or have been granted access to.">
      <ul className="divide-y rounded-md border">
        {(mailboxesData?.mailboxes ?? []).map((m) => (
          <MailboxRow key={m.id} mailbox={m} />
        ))}
        {mailboxesData?.mailboxes.length === 0 && (
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
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: () => unwrap(rpc.domains.$get()),
  });
  const { data: usersData } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => unwrap(rpc.users.$get()),
  });
  const { data: mailboxesData } = useQuery({
    queryKey: ["admin-mailboxes"],
    queryFn: () => unwrap(rpc.admin.mailboxes.$get()),
  });
  const { data: redirectsData } = useQuery({
    queryKey: ["admin-redirects"],
    queryFn: () => unwrap(rpc.admin.redirects.$get()),
  });
  // Owned mailboxes carry permission bits; used to enable group member management.
  const { data: ownData } = useQuery(mailboxesQuery);
  const ownById = new Map((ownData?.mailboxes ?? []).map((m) => [m.id, m]));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
    qc.invalidateQueries({ queryKey: ["admin-redirects"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };

  const mailboxes = mailboxesData?.mailboxes ?? [];
  const redirects = redirectsData?.redirects ?? [];

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
    .filter((e) => {
      if (kindFilter !== "all" && kindOf(e) !== kindFilter) return false;
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

  const eligibleDomains = (domainsData?.domains ?? []).filter((d) => d.allowedKinds !== 0);

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
              users={usersData?.users ?? []}
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
            allDomains={domainsData?.domains ?? []}
            users={usersData?.users ?? []}
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

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in onCreated
  const create = useMutation({
    mutationFn: () =>
      unwrap(rpc.mailboxes.$post({ json: { domainId: domain, localPart: local, type } })),
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
      <Button
        variant="primary"
        onClick={() => create.mutate()}
        disabled={!domain || !local || create.isPending}
      >
        Add mailbox
      </Button>
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
  users: Pick<AdminUser, "id" | "email">[];
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

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in onCreated
  const createMailbox = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.admin.mailboxes.$post({
          json: { domainId: domain, localPart: local, type, ownerUserId: ownerId },
        }),
      ),
    onSuccess: () => {
      setLocal("");
      onCreated();
      toast.success("Mailbox created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in onCreated
  const createRedirect = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.admin.redirects.$post({
          json: { domainId: rDomain, localPart: effLocal, targetMailboxId: target },
        }),
      ),
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
      <ToggleGroup value={mode} onValueChange={setMode}>
        <ToggleItem value="mailbox">New mailbox</ToggleItem>
        <ToggleItem value="redirect">New redirect</ToggleItem>
      </ToggleGroup>

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
          <Button
            variant="primary"
            onClick={() => createMailbox.mutate()}
            disabled={!domain || !local || !ownerId || createMailbox.isPending}
          >
            Add mailbox
          </Button>
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
          <Button
            variant="primary"
            onClick={() => createRedirect.mutate()}
            disabled={!rDomain || !effLocal || !target || createRedirect.isPending}
          >
            Add redirect
          </Button>
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
  const [target, setTarget] = useState(() => rd.targetMailboxId);
  const { confirmDelete } = useConfirmHelpers();

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const migrate = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.admin.redirects[":id"].$patch({
          param: { id: rd.id },
          json: { targetMailboxId: target },
        }),
      ),
    onSuccess: () => {
      setMigrateOpen(false);
      invalidate();
      toast.success("Redirect re-pointed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const remove = useMutation({
    mutationFn: () => unwrap(rpc.admin.redirects[":id"].$delete({ param: { id: rd.id } })),
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setTarget(rd.targetMailboxId);
              setMigrateOpen((v) => !v);
            }}
          >
            Migrate
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
          </Button>
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
          <Button
            variant="primary"
            onClick={() => migrate.mutate()}
            disabled={target === rd.targetMailboxId || migrate.isPending}
          >
            Migrate
          </Button>
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
  users: Pick<AdminUser, "id" | "email">[];
  allMailboxes: AdminMailbox[];
  manageable: boolean;
  invalidate: () => void;
}) {
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOwner, setNewOwner] = useState(() => m.ownerUserId);
  const [newType, setNewType] = useState(() => m.type);
  const [redirectTo, setRedirectTo] = useState("");

  // Only personal⇄group are interchangeable; temp/service have no type toggle.
  const canRetype = m.type === "personal" || m.type === "group";
  const ownerChanged = newOwner !== m.ownerUserId;
  const typeChanged = canRetype && newType !== m.type;

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const migrate = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.admin.mailboxes[":id"].$patch({
          param: { id: m.id },
          json: {
            ...(ownerChanged ? { ownerUserId: newOwner } : {}),
            // canRetype already restricts to personal⇄group; narrow for the wire type.
            ...(typeChanged && (newType === "personal" || newType === "group")
              ? { type: newType }
              : {}),
          },
        }),
      ),
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

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.admin.mailboxes[":id"].$delete({
          param: { id: m.id },
          json: redirectTo ? { redirectToMailboxId: redirectTo } : {},
        }),
      ),
    onSuccess: () => {
      setDeleteOpen(false);
      invalidate();
      toast.success(redirectTo ? "Mailbox deleted, redirect created" : "Mailbox deleted");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const empty = useMutation({
    mutationFn: () => unwrap(rpc.admin.mailboxes[":id"].empty.$post({ param: { id: m.id } })),
    onSuccess: () => {
      setEmptyOpen(false);
      invalidate();
      toast.success("Mailbox emptied");
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMembersOpen((v) => !v);
                setMigrateOpen(false);
                setDeleteOpen(false);
                setSettingsOpen(false);
              }}
            >
              {membersOpen ? "Hide members" : "Members"}
            </Button>
          )}
          {m.type !== "temp" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSettingsOpen((v) => !v);
                setMigrateOpen(false);
                setDeleteOpen(false);
                setMembersOpen(false);
              }}
            >
              {settingsOpen ? "Hide settings" : "Settings"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
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
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setEmptyOpen(true);
              setMigrateOpen(false);
              setDeleteOpen(false);
              setMembersOpen(false);
              setSettingsOpen(false);
            }}
          >
            Empty
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setRedirectTo("");
              setDeleteOpen(true);
              setMigrateOpen(false);
              setMembersOpen(false);
              setSettingsOpen(false);
            }}
          >
            Delete
          </Button>
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
            <Button
              variant="primary"
              onClick={() => migrate.mutate()}
              disabled={(!ownerChanged && !typeChanged) || migrate.isPending}
            >
              Migrate
            </Button>
          </div>
        </div>
      )}

      <Dialog open={emptyOpen} onOpenChange={setEmptyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Empty {m.address}?</DialogTitle>
            <DialogDescription>
              Permanently deletes all threads, messages, and attachments in this mailbox. The
              mailbox itself is kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button variant="destructive" onClick={() => empty.mutate()} disabled={empty.isPending}>
              {empty.isPending ? "Emptying…" : "Empty mailbox"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide members" : "Members"}
          </Button>
        )}
      </div>
      {canManage && open && <MembersPanel mailboxId={m.id} />}
    </li>
  );
}

function MembersPanel({ mailboxId }: { mailboxId: string }) {
  const qc = useQueryClient();
  const { confirm } = useConfirmHelpers();
  const { data: membersData } = useQuery({
    queryKey: ["mailbox-members", mailboxId],
    queryFn: () => unwrap(rpc.mailboxes[":id"].members.$get({ param: { id: mailboxId } })),
  });
  const { data: invitesData } = useQuery({
    queryKey: ["mailbox-invites", mailboxId],
    queryFn: () => unwrap(rpc.mailboxes[":id"].invites.$get({ param: { id: mailboxId } })),
  });

  const { data: directoryData, isLoading: directoryLoading } = useQuery({
    queryKey: ["user-directory"],
    queryFn: () => unwrap(rpc.users.directory.$get()),
  });

  const [selectedUserId, setSelectedUserId] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [manage, setManage] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["mailbox-members", mailboxId] });
    qc.invalidateQueries({ queryKey: ["mailbox-invites", mailboxId] });
  };

  const memberIds = new Set((membersData?.members ?? []).map((m) => m.userId));
  const candidates = (directoryData?.users ?? []).filter((u) => !memberIds.has(u.id));

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in local invalidate
  const addMember = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.mailboxes[":id"].members.$post({
          param: { id: mailboxId },
          json: { mailboxId, userId: selectedUserId, read, write, manage },
        }),
      ),
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

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in local invalidate
  const removeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      unwrap(
        rpc.mailboxes[":id"].invites[":inviteId"].$delete({ param: { id: mailboxId, inviteId } }),
      ),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in local invalidate
  const updatePerms = useMutation({
    mutationFn: ({ userId, perms }: { userId: string; perms: number }) =>
      unwrap(
        rpc.mailboxes[":id"].members.$post({
          param: { id: mailboxId },
          json: {
            mailboxId,
            userId,
            read: has(perms, Perm.READ),
            write: has(perms, Perm.WRITE),
            manage: has(perms, Perm.MANAGE),
          },
        }),
      ),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in local invalidate
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      unwrap(rpc.mailboxes[":id"].members[":userId"].$delete({ param: { id: mailboxId, userId } })),
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
        {(membersData?.members ?? []).map((member) => (
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
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
              </Button>
            </div>
          </li>
        ))}
        {membersData?.members.length === 0 &&
          (!invitesData || invitesData.invites.length === 0) && (
            <li className="px-3 py-4 text-center text-[11px] text-muted-foreground">
              No members yet.
            </li>
          )}
        {(invitesData?.invites ?? []).map((inv) => (
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
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selectedUserId}
          onValueChange={setSelectedUserId}
          className="min-w-[200px] flex-1"
          disabled={directoryLoading}
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
        <Button
          variant="primary"
          onClick={() => addMember.mutate()}
          disabled={!selectedUserId || addMember.isPending}
        >
          Add
        </Button>
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
