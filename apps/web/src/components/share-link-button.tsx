import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link as LinkIcon, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCreated(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm">
            <Share2 /> Share
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-3">
        <div className="mb-2 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
          Read-only share link
        </div>
        {created ? (
          <CreatedPanel created={created} />
        ) : (
          <div className="flex flex-col gap-3">
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
            <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
              <LinkIcon />
              {create.isPending ? "Creating…" : "Create link"}
            </Button>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Anyone with the link can read this mailbox's messages until the link expires.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
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
          <code className="flex-1 truncate text-[11px]">{created.url}</code>
          <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy link">
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Expires {new Date(created.expiresAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
}
