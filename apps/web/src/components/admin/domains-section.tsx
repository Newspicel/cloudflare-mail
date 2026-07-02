import { MailboxKind } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type Domain, KindCheckboxes, Section } from "@/components/admin/shared.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirm } from "@/components/ui/confirm.tsx";
import { Input } from "@/components/ui/input.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";

export function DomainsSection() {
  const qc = useQueryClient();
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: () => unwrap(rpc.domains.$get()),
  });
  const { data: settingsData } = useQuery({
    queryKey: ["domains-settings"],
    queryFn: () => unwrap(rpc.domains.settings.$get()),
  });

  const [newDomain, setNewDomain] = useState("");
  const [newKinds, setNewKinds] = useState<number>(MailboxKind.PERSONAL);

  const addDomain = useMutation({
    mutationFn: () =>
      unwrap(rpc.domains.$post({ json: { name: newDomain, allowedKinds: newKinds } })),
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
      unwrap(rpc.domains.settings["auth-from"].$put({ json: { address: fromAddr } })),
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
            value={fromAddr || settingsData?.authFromAddress || ""}
            onChange={(e) => setFromAddr(e.target.value)}
            placeholder="noreply@example.com"
            className="flex-1"
          />
          <Button
            variant="primary"
            onClick={() => saveFrom.mutate()}
            disabled={!fromAddr || saveFrom.isPending}
          >
            Save
          </Button>
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
              {(domainsData?.domains ?? []).map((d) => (
                <DomainRow key={d.id} domain={d} />
              ))}
              {domainsData?.domains.length === 0 && (
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
          <Button
            variant="primary"
            onClick={() => addDomain.mutate()}
            disabled={!newDomain || addDomain.isPending}
          >
            Add domain
          </Button>
        </div>
      </Section>
    </div>
  );
}

function DomainRow({ domain: d }: { domain: Domain }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const recheck = useMutation({
    mutationFn: () => unwrap(rpc.domains[":id"].check.$post({ param: { id: d.id } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("DNS rechecked");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const setKinds = useMutation({
    mutationFn: (allowedKinds: number) =>
      unwrap(rpc.domains[":id"].$patch({ param: { id: d.id }, json: { allowedKinds } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const deleteDom = useMutation({
    mutationFn: () => unwrap(rpc.domains[":id"].$delete({ param: { id: d.id } })),
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => recheck.mutate()}
            disabled={recheck.isPending}
          >
            {recheck.isPending ? "Checking…" : "Recheck"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
          </Button>
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
