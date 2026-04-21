import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link as LinkIcon, Share2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";

interface CreatedToken {
  id: string;
  url: string;
  expiresAt: string;
}

const TTL_PRESETS: { label: string; seconds: number }[] = [
  { label: "24h", seconds: 24 * 3600 },
  { label: "7d", seconds: 7 * 24 * 3600 },
  { label: "30d", seconds: 30 * 24 * 3600 },
];

export function ShareLinkButton({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState(TTL_PRESETS[1]!.seconds);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
    function close() {
      setOpen(false);
      setCreated(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api<CreatedToken>(`/api/mailboxes/${mailboxId}/share-tokens`, {
        method: "POST",
        body: JSON.stringify({ ttlSeconds }),
      }),
    onSuccess: (res) => setCreated(res),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
          open ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        )}
      >
        <Share2 className="h-3.5 w-3.5" /> Share
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Read-only share link
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreated(null);
              }}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {created ? (
            <CreatedPanel created={created} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Expires after</span>
                <div className="flex gap-1">
                  {TTL_PRESETS.map((p) => (
                    <button
                      key={p.seconds}
                      type="button"
                      onClick={() => setTtlSeconds(p.seconds)}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1.5 text-xs transition",
                        ttlSeconds === p.seconds
                          ? "border-primary bg-primary text-primary-foreground"
                          : "hover:bg-accent",
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
                disabled={create.isPending}
                className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-105 disabled:opacity-50"
              >
                <LinkIcon className="h-3.5 w-3.5" />
                {create.isPending ? "Creating…" : "Create link"}
              </button>
              <p className="text-[11px] text-muted-foreground">
                Anyone with the link can read this mailbox's messages until the link expires.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreatedPanel({ created }: { created: CreatedToken }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border bg-muted/40 p-2">
        <div className="flex items-center gap-1">
          <code className="flex-1 truncate text-xs">{created.url}</code>
          <button
            type="button"
            onClick={copy}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Copy link"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Expires {new Date(created.expiresAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
}
