import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { keys } from "@/lib/query-keys.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

interface TempDomain {
  id: string;
  name: string;
}

interface CreatedTemp {
  id: string;
  address: string;
  expiresAt: string;
}

const tempDomainsQueryOptions = {
  queryKey: ["temp-domains"],
  queryFn: () => api<{ domains: TempDomain[] }>("/api/temp/domains"),
};

const TTL_PRESETS: { label: string; seconds: number }[] = [
  { label: "1h", seconds: 3600 },
  { label: "6h", seconds: 6 * 3600 },
  { label: "24h", seconds: 24 * 3600 },
  { label: "7d", seconds: 7 * 24 * 3600 },
];

export function NewTempMailbox() {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedTemp | null>(null);
  const domainsQ = useQuery(tempDomainsQueryOptions);

  // Hide entirely when the user can't create a temp mailbox on any domain, but
  // keep its slot so the sidebar header height stays the same with or without it.
  if ((domainsQ.data?.domains.length ?? 0) === 0)
    return <div className="h-8 shrink-0" aria-hidden />;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCreated(null);
      }}
    >
      <PopoverTrigger
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-card px-2.5 text-[13px] text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 data-[popup-open]:bg-sidebar-accent",
        )}
      >
        <Timer className="h-3.5 w-3.5" />
        New temp mailbox
      </PopoverTrigger>
      <PopoverContent className="w-[var(--anchor-width)] p-3">
        <div className="mb-2 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
          Temporary mailbox
        </div>
        {created ? (
          <CreatedPanel created={created} onDone={() => setOpen(false)} />
        ) : (
          <TempForm onCreated={setCreated} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function TempForm({ onCreated }: { onCreated: (t: CreatedTemp) => void }) {
  const qc = useQueryClient();
  const domainsQ = useQuery(tempDomainsQueryOptions);
  const tempDomains = domainsQ.data?.domains ?? [];
  const firstDomainId = tempDomains[0]?.id;

  const [domainId, setDomainId] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(TTL_PRESETS[0]!.seconds);

  useEffect(() => {
    if (!domainId && firstDomainId) setDomainId(firstDomainId);
  }, [domainId, firstDomainId]);

  const create = useMutation({
    mutationFn: () =>
      api<CreatedTemp>("/api/temp", {
        method: "POST",
        body: JSON.stringify({ domainId, ttlSeconds }),
      }),
    onSuccess: (res) => {
      onCreated(res);
      qc.invalidateQueries({ queryKey: keys.mailboxes() });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  if (tempDomains.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No domain allows temp mailboxes. Enable the{" "}
        <code className="rounded bg-muted px-1">temp</code> kind on a domain in Admin first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {tempDomains.length > 1 ? (
        <div className="flex flex-col gap-1 text-[11px]">
          <span className="text-muted-foreground">Domain</span>
          <Select
            items={tempDomains.map((d) => ({ value: d.id, label: `@${d.name}` }))}
            value={domainId}
            onValueChange={(v) => setDomainId(v as string)}
          >
            <SelectTrigger aria-label="Domain">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tempDomains.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  @{d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          Domain: <span className="font-medium text-foreground">@{tempDomains[0]!.name}</span>
        </div>
      )}

      <div className="flex flex-col gap-1 text-[11px]">
        <span className="text-muted-foreground">Expires after</span>
        <div className="flex gap-1">
          {TTL_PRESETS.map((p) => (
            <Button
              key={p.seconds}
              variant={ttlSeconds === p.seconds ? "primary" : "outline"}
              size="sm"
              className="flex-1"
              onClick={() => setTtlSeconds(p.seconds)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      <Button
        variant="primary"
        onClick={() => create.mutate()}
        disabled={!domainId || create.isPending}
      >
        {create.isPending ? "Creating…" : "Create"}
      </Button>
    </div>
  );
}

function CreatedPanel({ created, onDone }: { created: CreatedTemp; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.address);
      setCopied(true);
      toast.success("Address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border bg-muted/40 p-2">
        <div className="flex items-center gap-1">
          <code className="flex-1 truncate text-[11px]">{created.address}</code>
          <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy address">
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Expires {new Date(created.expiresAt).toLocaleString()}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
