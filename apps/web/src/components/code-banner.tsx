import { Check, Copy, KeyRound, LogIn } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { detectCodesAndLinks } from "@/lib/detect-codes.ts";

// One-tap copy for a detected verification code.
function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Code copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-2 rounded-md border border-primary/30 bg-background px-2.5 py-1 font-mono font-semibold text-[14px] tracking-[0.15em] transition-colors hover:bg-primary/10"
      aria-label={`Copy code ${code}`}
    >
      <span>{code}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-success" />
      ) : (
        <Copy className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

// Surfaces verification codes / magic sign-in links detected in an inbound
// message so they can be copied or opened without digging through the body.
export function CodeBanner({
  subject,
  text,
  html,
  direction,
}: {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  direction: string;
}) {
  const detected = detectCodesAndLinks({ subject, text, html });

  if (direction !== "in") return null;
  if (detected.codes.length === 0 && detected.links.length === 0) return null;

  return (
    <div className="border-b bg-primary/5 px-4 py-2.5 text-[12px] dark:bg-primary/10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <KeyRound className="size-4 shrink-0 text-primary" />
          <span className="font-semibold uppercase tracking-wide text-[10px]">
            {detected.codes.length > 0 ? "Verification code" : "Sign-in link"}
          </span>
        </div>
        {detected.codes.map((c) => (
          <CodeChip key={c.code} code={c.code} />
        ))}
        {detected.links.map((l) => (
          <a
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-medium text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <LogIn className="size-3.5 shrink-0" />
            {l.label}
          </a>
        ))}
      </div>
    </div>
  );
}
