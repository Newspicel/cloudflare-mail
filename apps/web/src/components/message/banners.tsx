import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { KeyRound, MailMinus, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import type { MessageRow } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { authStatus, shortFingerprint } from "./sender-lock.tsx";

export function SpamBanner({ msg }: { msg: MessageRow }) {
  if (msg.direction !== "in") return null;
  const verdict = msg.spamVerdict;
  const auth = authStatus(msg.spamAuth);
  const flagged = verdict === "spam" || verdict === "suspicious";
  // Surface a sender-authentication warning even when the message wasn't
  // classified as spam — a spoofed From must not be rendered as trusted.
  if (!flagged && auth !== "fail") return null;

  const reasons = [...(msg.spamReasons ?? [])];
  if (auth === "fail" && !reasons.length) {
    reasons.push("The sender's address could not be verified — it may be forged (spoofed).");
  }
  const isSpam = verdict === "spam";
  const title = isSpam
    ? "This message was flagged as spam"
    : verdict === "suspicious"
      ? "This message looks suspicious"
      : "Could not verify this sender";
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b px-4 py-2.5 text-[12px]",
        isSpam
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div>
        <div className="font-semibold">{title}</div>
        {reasons.length > 0 && (
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PgpBannerShell({
  tone,
  Icon,
  title,
  action,
  children,
}: {
  tone: "destructive" | "warning" | "muted";
  Icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles =
    tone === "destructive"
      ? "bg-destructive/10 text-destructive"
      : tone === "warning"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-muted/60 text-muted-foreground";
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-b px-4 py-2.5 text-[12px]",
        styles,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold">{title}</div>
          <div className="mt-0.5">{children}</div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// PGP trust banners (inbound only): surface a bad signature, a key rotation, an
// auto-captured key, or an action to fetch-and-save the key of a signed sender we
// can't yet verify. The "trust sender" action hits the worker, which extracts the
// sender's key from the stored message (or fetches it via WKD) and re-verifies.
export function PgpBanner({ msg, readOnly }: { msg: MessageRow; readOnly: boolean }) {
  const qc = useQueryClient();
  const trust = useMutation({
    mutationFn: () =>
      unwrap(rpc.messages[":id"].pgp["trust-sender"].$post({ param: { id: msg.id } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.thread(msg.threadId) });
      toast.success(`Saved key for ${msg.fromAddr}`);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Couldn't find a key for this sender"),
  });
  const trustButton = (label: string, busy: string) =>
    !readOnly && (
      <Button
        size="sm"
        variant="secondary"
        disabled={trust.isPending}
        onClick={() => trust.mutate()}
      >
        {trust.isPending ? busy : label}
      </Button>
    );

  if (msg.direction !== "in") return null;

  // Loudest: a signature that failed verification — altered or forged.
  if (msg.pgpSigned && msg.pgpVerify === "bad") {
    return (
      <PgpBannerShell tone="destructive" Icon={ShieldAlert} title="Bad PGP signature">
        This message's signature failed to verify — it may have been altered in transit or forged.
      </PgpBannerShell>
    );
  }

  // A known contact signed with a different key than the one on file.
  if (msg.pgpKeyEvent === "rotated") {
    return (
      <PgpBannerShell
        tone="warning"
        Icon={KeyRound}
        title="Sender used a new PGP key"
        action={trustButton("Trust new key", "Updating…")}
      >
        {msg.fromAddr} signed with a key that doesn't match the one saved for them. If they rotated
        keys, update it; if this is unexpected, verify the fingerprint out-of-band first.
      </PgpBannerShell>
    );
  }

  // Signed, but we have no key for the sender to check it — offer to fetch + save.
  if (msg.pgpSigned && msg.pgpVerify === "unknown" && !msg.pgpKey) {
    return (
      <PgpBannerShell
        tone="muted"
        Icon={ShieldQuestion}
        title="Signed — can't verify"
        action={trustButton("Verify & save key", "Saving…")}
      >
        This message is PGP-signed but we have no key for {msg.fromAddr} to verify it.
      </PgpBannerShell>
    );
  }

  // A key was just captured from this message (TOFU / WKD) — let the user know.
  if (msg.pgpKeyEvent === "captured" && msg.pgpKey) {
    return (
      <PgpBannerShell tone="muted" Icon={KeyRound} title="Saved sender's PGP key">
        Stored {shortFingerprint(msg.pgpKey.fingerprint)} for {msg.fromAddr}. Future mail is
        verified automatically, and replies can be encrypted.
      </PgpBannerShell>
    );
  }

  return null;
}

// Newsletters carry a List-Unsubscribe header; surface a one-tap opt-out. The
// worker decides the channel (one-click POST / mailto / link) — a "link" result
// is an https page we open in a new tab, everything else is handled server-side.
export function UnsubscribeBanner({ msg, readOnly }: { msg: MessageRow; readOnly: boolean }) {
  const [done, setDone] = useState(false);
  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- unsubscribe is a best-effort action; it changes no cached mail data (banner hidden via local `done` state)
  const unsub = useMutation({
    mutationFn: () => unwrap(rpc.messages[":id"].unsubscribe.$post({ param: { id: msg.id } })),
    onSuccess: (res) => {
      if (res.status === "open" && res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
        return;
      }
      setDone(true);
      toast.success("Unsubscribe request sent");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to unsubscribe"),
  });

  if (msg.direction !== "in" || !msg.listUnsubscribe) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b bg-muted/60 px-4 py-2 text-[12px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <MailMinus className="size-4 shrink-0" />
        <span className="truncate">
          {done ? "Unsubscribe request sent." : "This is a newsletter."}
        </span>
      </div>
      {!readOnly && !done && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => unsub.mutate()}
          disabled={unsub.isPending}
        >
          {unsub.isPending ? "Unsubscribing…" : "Unsubscribe"}
        </Button>
      )}
    </div>
  );
}
