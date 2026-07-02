import type { LucideIcon } from "lucide-react";
import { Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { MessageRow } from "@/lib/queries.ts";

// Interpret the parsed Authentication-Results summary. "fail" means the sender
// is likely forged; "unverified" means we couldn't confirm it (no/none auth).
export function authStatus(auth: MessageRow["spamAuth"]): "pass" | "fail" | "unverified" | null {
  if (!auth) return null;
  if (auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass")) return "pass";
  if (auth.dmarc === "fail" || (auth.spf === "fail" && auth.dkim === "fail")) return "fail";
  if (!auth.spf && !auth.dkim && !auth.dmarc) return null;
  return "unverified";
}

export function shortFingerprint(fp: string): string {
  const s = fp.replace(/\s/g, "").toUpperCase();
  return s.length > 16 ? `${s.slice(0, 4)}…${s.slice(-8)}` : s;
}

// A single Proton-style padlock shown in front of the sender, folding the
// strongest available trust signal into one glyph: end-to-end PGP encryption,
// PGP signature verification, then transport authentication (SPF/DKIM/DMARC).
type LockTone = "success" | "warning" | "destructive" | "muted";

const LOCK_TONES: Record<LockTone, string> = {
  success: "text-success",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function senderLock(
  msg: MessageRow,
): { Icon: LucideIcon; tone: LockTone; title: string; detail?: string } | null {
  const inbound = msg.direction === "in";

  // 1. PGP encryption — end-to-end, the strongest signal.
  if (msg.pgpEncrypted) {
    if (inbound && msg.pgpSigned && msg.pgpVerify === "bad")
      return {
        Icon: Lock,
        tone: "destructive",
        title: "Encrypted · bad signature",
        detail: "End-to-end encrypted, but the sender's signature failed to verify.",
      };
    const detail = !msg.pgpSigned
      ? undefined
      : !inbound
        ? "Signed with your key."
        : msg.pgpVerify === "good"
          ? "Signed and verified."
          : "Signed, but the signature could not be verified.";
    return { Icon: Lock, tone: "success", title: "End-to-end encrypted", detail };
  }

  // 2. PGP signature without encryption.
  if (msg.pgpSigned) {
    if (!inbound)
      return {
        Icon: ShieldCheck,
        tone: "success",
        title: "Digitally signed",
        detail: "Signed with your key.",
      };
    if (msg.pgpVerify === "good") {
      const fp = msg.pgpKey ? ` (${shortFingerprint(msg.pgpKey.fingerprint)})` : "";
      return msg.pgpKey?.verified
        ? {
            Icon: ShieldCheck,
            tone: "success",
            title: "Signed — verified key",
            detail: `Valid signature from a confirmed key${fp}.`,
          }
        : {
            Icon: ShieldCheck,
            tone: "success",
            title: "Signed — verified",
            detail: `Valid PGP signature${fp}. Confirm the key's fingerprint to fully trust it.`,
          };
    }
    if (msg.pgpVerify === "bad")
      return {
        Icon: ShieldAlert,
        tone: "destructive",
        title: "Bad signature",
        detail: "The PGP signature is invalid — this message may be forged.",
      };
    return {
      Icon: ShieldQuestion,
      tone: "warning",
      title: "Signed · unverified",
      detail: "Signed, but we have no key to verify the signature.",
    };
  }

  // 3. Transport authentication (inbound only) — SPF / DKIM / DMARC.
  if (inbound) {
    const auth = authStatus(msg.spamAuth);
    if (auth === "pass")
      return {
        Icon: ShieldCheck,
        tone: "muted",
        title: "Authenticated sender",
        detail: "Passed SPF / DKIM / DMARC checks.",
      };
    if (auth === "fail")
      return {
        Icon: LockOpen,
        tone: "destructive",
        title: "Unverified sender",
        detail: "Failed authentication — the address may be spoofed.",
      };
    if (auth === "unverified")
      return {
        Icon: ShieldQuestion,
        tone: "muted",
        title: "Not authenticated",
        detail: "The sender's domain isn't authenticated.",
      };
  }

  return null;
}

export function SenderLock({ msg }: { msg: MessageRow }) {
  const lock = senderLock(msg);
  if (!lock) return null;
  const { Icon, tone, title, detail } = lock;
  return (
    <Tooltip label={detail ? `${title} — ${detail}` : title}>
      <span className={cn("inline-grid shrink-0 place-items-center", LOCK_TONES[tone])}>
        <Icon className="size-3.5" aria-label={title} />
      </span>
    </Tooltip>
  );
}
