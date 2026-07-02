import { MailboxKind } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type Domain, KindBadge, Mono, Section, Select } from "@/components/admin/shared.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirm } from "@/components/ui/confirm.tsx";
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
import { rpc, unwrap } from "@/lib/api.ts";

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

export function ServiceSection() {
  const qc = useQueryClient();
  const { data: servicesData } = useQuery({
    queryKey: ["admin-service"],
    queryFn: () => unwrap(rpc.admin.service.$get()),
  });
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: () => unwrap(rpc.domains.$get()),
  });

  // The plaintext key is returned once on create/rotate — surface it in a modal.
  const [revealed, setRevealed] = useState<{ address: string; key: string } | null>(null);

  const eligibleDomains = (domainsData?.domains ?? []).filter(
    (d) => (d.allowedKinds & MailboxKind.SERVICE) === MailboxKind.SERVICE,
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-service"] });
  const services = servicesData?.services ?? [];

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

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in onCreated
  const create = useMutation({
    mutationFn: () =>
      unwrap(rpc.admin.service.$post({ json: { domainId, localPart: local, mode } })),
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
      <Button
        variant="primary"
        onClick={() => create.mutate()}
        disabled={!domainId || !local || create.isPending}
      >
        Add service
      </Button>
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

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const rotate = useMutation({
    mutationFn: () => unwrap(rpc.admin.service[":id"].rotate.$post({ param: { id: s.id } })),
    onSuccess: (res) => {
      invalidate();
      onKey({ address: s.address, key: res.key });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const setMode = useMutation({
    mutationFn: (mode: "duplex" | "send") =>
      unwrap(rpc.admin.service[":id"].$patch({ param: { id: s.id }, json: { mode } })),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidation runs in injected invalidate
  const remove = useMutation({
    mutationFn: () => unwrap(rpc.admin.service[":id"].$delete({ param: { id: s.id } })),
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => rotate.mutate()}
            disabled={rotate.isPending}
          >
            {rotate.isPending ? "Rotating…" : "Rotate key"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
          </Button>
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
