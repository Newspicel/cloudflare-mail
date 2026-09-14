import { useState } from "react";
import { cn } from "@/lib/cn.ts";

// A correspondent's mark. When their domain publishes a BIMI record the real
// brand logo is served from `/api/avatar/domain/<domain>` (see
// `worker/src/mail/bimi.ts`); otherwise this falls back to initials on a tint
// derived from the address, so the same sender always looks the same.
//
// The logo is decoration, never a trust signal: BIMI's `a=` mark certificate is
// not verified, so nothing here says "this sender is genuine".

const TINTS = [
  "bg-indigo-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-purple-500",
  "bg-green-600",
  "bg-blue-500",
  "bg-amber-600",
  "bg-cyan-600",
  "bg-rose-500",
];

function tintFor(address: string): string {
  let hash = 5381;
  for (const ch of address.toLowerCase()) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length] as string;
}

function initialsFor(name: string | undefined, address: string): string {
  const source = name?.trim() || address;
  const words = source.split(/[\s._-]+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const first = [...source].find((c) => /[\p{L}\p{N}]/u.test(c));
  return (first ?? "?").toUpperCase();
}

/** Organizational-ish domain of an address, minus common transport labels. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const host = address
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.+$/, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? host : null;
}

export function SenderAvatar({
  name,
  address,
  size = 36,
  className,
}: {
  name?: string;
  address: string;
  size?: number;
  className?: string;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const domain = domainOf(address);
  const showLogo = domain !== null && !logoFailed;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold text-white",
        !showLogo && tintFor(address),
        showLogo && "bg-muted",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {showLogo ? (
        <img
          src={`/api/avatar/domain/${encodeURIComponent(domain)}`}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        initialsFor(name, address)
      )}
    </span>
  );
}
