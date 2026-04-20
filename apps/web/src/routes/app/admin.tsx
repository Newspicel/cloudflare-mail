import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { mailboxesQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/admin")({
  component: AdminPage,
});

interface Domain {
  id: string;
  name: string;
  kind: "primary" | "sub";
  isTempDomain: boolean;
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
            <li key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <div className="font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground">
                  {d.kind}
                  {d.isTempDomain && " · temp"}
                </div>
              </div>
            </li>
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
            <li key={m.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <div className="font-medium">{m.address}</div>
                <div className="text-xs text-muted-foreground">
                  {m.type} · {m.role}
                  {m.expiresAt && ` · expires ${new Date(m.expiresAt).toLocaleString()}`}
                </div>
              </div>
            </li>
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
