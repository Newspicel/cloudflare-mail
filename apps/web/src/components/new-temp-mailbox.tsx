import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Timer, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";

interface Domain {
  id: string;
  name: string;
  kind: "primary" | "sub";
  isTempDomain: boolean;
}

interface CreatedTemp {
  id: string;
  address: string;
  expiresAt: string;
}

const TTL_PRESETS: { label: string; seconds: number }[] = [
  { label: "1h", seconds: 3600 },
  { label: "6h", seconds: 6 * 3600 },
  { label: "24h", seconds: 24 * 3600 },
  { label: "7d", seconds: 7 * 24 * 3600 },
];

export function NewTempMailbox() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-card px-2.5 py-1.5 text-[13px] text-sidebar-foreground transition hover:bg-sidebar-accent",
          open && "bg-sidebar-accent",
        )}
      >
        <Timer className="h-3.5 w-3.5" />
        New temp mailbox
      </button>
      {open && <TempPopover onClose={() => setOpen(false)} />}
    </div>
  );
}

function TempPopover({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: () => api<{ domains: Domain[] }>("/api/domains"),
  });
  const tempDomains = (domainsQ.data?.domains ?? []).filter((d) => d.isTempDomain);

  const [domainId, setDomainId] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(TTL_PRESETS[0]!.seconds);
  const [created, setCreated] = useState<CreatedTemp | null>(null);

  useEffect(() => {
    if (!domainId && tempDomains[0]) setDomainId(tempDomains[0].id);
  }, [domainId, tempDomains]);

  const create = useMutation({
    mutationFn: () =>
      api<CreatedTemp>("/api/temp", {
        method: "POST",
        body: JSON.stringify({ domainId, ttlSeconds }),
      }),
    onSuccess: (res) => {
      setCreated(res);
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Temporary mailbox
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {created ? (
        <CreatedPanel created={created} onDone={onClose} />
      ) : tempDomains.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No domain is marked as temp. Set{" "}
          <code className="rounded bg-muted px-1">is_temp_domain</code> on a domain in Admin first.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {tempDomains.length > 1 && (
            <label className="flex flex-col gap-1 text-[11px]">
              <span className="text-muted-foreground">Domain</span>
              <select
                value={domainId}
                onChange={(e) => setDomainId(e.target.value)}
                className="rounded-md border bg-background px-2 py-1.5 text-[13px]"
              >
                {tempDomains.map((d) => (
                  <option key={d.id} value={d.id}>
                    @{d.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {tempDomains.length === 1 && (
            <div className="text-[11px] text-muted-foreground">
              Domain: <span className="font-medium text-foreground">@{tempDomains[0]!.name}</span>
            </div>
          )}

          <div className="flex flex-col gap-1 text-[11px]">
            <span className="text-muted-foreground">Expires after</span>
            <div className="flex gap-1">
              {TTL_PRESETS.map((p) => (
                <button
                  key={p.seconds}
                  type="button"
                  onClick={() => setTtlSeconds(p.seconds)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition",
                    ttlSeconds === p.seconds
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-muted",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!domainId || create.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      )}
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
          <button
            type="button"
            onClick={copy}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Copy address"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Expires {new Date(created.expiresAt).toLocaleString()}
        </div>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="rounded-md border px-3 py-1.5 text-[11px] font-medium hover:bg-muted"
      >
        Done
      </button>
    </div>
  );
}
