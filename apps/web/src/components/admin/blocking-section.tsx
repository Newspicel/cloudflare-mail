import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Section, Select } from "@/components/admin/shared.tsx";
import { TokenField } from "@/components/token-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirm, useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { Input } from "@/components/ui/input.tsx";
import { rpc, unwrap } from "@/lib/api.ts";

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

type RequestAction = "approve" | "deny" | "dismiss";

export function BlockingSection() {
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
  const { data: reqsData } = useQuery({
    queryKey: ["admin-block-requests"],
    queryFn: () => unwrap(rpc.admin.block.requests.$get()),
  });
  const all = reqsData?.requests ?? [];
  const pending = all.filter((r) => r.status === "pending");
  const reviewed = all.filter((r) => r.status !== "pending");

  const act = async (action: RequestAction, id: string) => {
    if (action === "approve") {
      await unwrap(rpc.admin.block.requests[":id"].approve.$post({ param: { id } }));
    } else if (action === "deny") {
      await unwrap(rpc.admin.block.requests[":id"].deny.$post({ param: { id } }));
    } else {
      await unwrap(rpc.admin.block.requests[":id"].$delete({ param: { id } }));
    }
    qc.invalidateQueries({ queryKey: ["admin-block-requests"] });
    qc.invalidateQueries({ queryKey: ["admin-blocklist"] });
  };

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
  act: (action: RequestAction, id: string) => Promise<unknown>;
}) {
  const { confirm } = useConfirmHelpers();
  const run = (action: RequestAction, ok: string) =>
    act(action, req.id)
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
              <Button variant="outline" size="sm" onClick={() => run("approve", "Sender blocked")}>
                <Check className="h-3.5 w-3.5" /> Approve
              </Button>
              <Button variant="outline" size="sm" onClick={() => run("deny", "Request denied")}>
                <X className="h-3.5 w-3.5" /> Deny
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={async () => {
              if (
                await confirm({
                  title: "Delete this block request?",
                  confirmLabel: "Delete",
                  destructive: true,
                })
              )
                run("dismiss", "Removed");
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

function BlocklistPanel() {
  const qc = useQueryClient();
  const { data: entriesData } = useQuery({
    queryKey: ["admin-blocklist"],
    queryFn: () => unwrap(rpc.admin.block.entries.$get()),
  });
  const [type, setType] = useState<"email" | "domain">("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.admin.block.entries.$post({
          json: { type, value: value.trim(), reason: reason.trim() || undefined },
        }),
      ),
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
        <Button type="submit" variant="primary" disabled={add.isPending || !value.trim()}>
          Add
        </Button>
      </form>

      {(entriesData?.entries.length ?? 0) === 0 ? (
        <p className="text-[12px] text-muted-foreground">Nothing blocked.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {(entriesData?.entries ?? []).map((entry) => (
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
    mutationFn: () => unwrap(rpc.admin.block.entries[":id"].$delete({ param: { id: entry.id } })),
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
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={remove.isPending}
          onClick={async () => {
            if (await confirm({ title: `Unblock ${entry.value}?` })) remove.mutate();
          }}
        >
          Unblock
        </Button>
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
  const { data: protectedData } = useQuery({
    queryKey: ["admin-protected-domains"],
    queryFn: () => unwrap(rpc.admin.block["protected-domains"].$get()),
  });
  // null = untouched (mirrors the server value); an array once edited locally.
  const [draft, setDraft] = useState<string[] | null>(null);
  const current = protectedData?.domains ?? [];
  const domains = draft ?? current;
  const dirty = draft !== null;

  const save = useMutation({
    mutationFn: () => unwrap(rpc.admin.block["protected-domains"].$put({ json: { domains } })),
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
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => setDraft(null)}
        >
          Reset
        </Button>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Section>
  );
}
