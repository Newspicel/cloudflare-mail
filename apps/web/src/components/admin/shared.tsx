import { MailboxKind } from "@cfmail/shared/permissions";
import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  SelectContent,
  SelectItem,
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import type { MailboxSummary } from "@/lib/queries.ts";

// Building blocks and shared row types for the Admin surface.

export interface Domain {
  id: string;
  name: string;
  allowedKinds: number;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  lastCheckedAt: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  banned: boolean;
  createdAt: string;
}

export interface DomainGrantRow {
  domainId: string;
  domainName: string;
  allowedKinds: number;
}

export interface AdminMailbox {
  id: string;
  address: string;
  displayName: string | null;
  type: "personal" | "group" | "service" | "temp";
  expiresAt: string | null;
  ownerUserId: string;
  ownerEmail: string;
  ownerName: string;
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border bg-card">
      <header className="flex items-start justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}

type SelectOption = { value: string; label: string; disabled?: boolean };

// Thin wrapper over the shared styled Select so admin call sites stay compact:
// pass `options` instead of composing the trigger/content by hand.
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  ariaLabel,
  title,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  title?: string;
}) {
  return (
    <SelectRoot
      items={options}
      value={value}
      onValueChange={(v) => onValueChange((v ?? "") as string)}
      disabled={disabled}
    >
      <SelectTrigger className={className} aria-label={ariaLabel} title={title}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export const KIND_CHECKBOXES: { label: string; bit: number; type: MailboxSummary["type"] }[] = [
  { label: "personal", bit: MailboxKind.PERSONAL, type: "personal" },
  { label: "group", bit: MailboxKind.GROUP, type: "group" },
  { label: "service", bit: MailboxKind.SERVICE, type: "service" },
  { label: "temp", bit: MailboxKind.TEMP, type: "temp" },
];

export function KindCheckboxes({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const baseId = useId();
  const toggle = (bit: number) => onChange((value & bit) === bit ? value & ~bit : value | bit);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {KIND_CHECKBOXES.map((k) => {
        const id = `${baseId}-${k.bit}`;
        return (
          <label
            key={k.label}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-1.5 select-none"
          >
            <Checkbox
              id={id}
              checked={(value & k.bit) === k.bit}
              onCheckedChange={() => toggle(k.bit)}
              className="size-3.5"
            />
            {k.label}
          </label>
        );
      })}
    </div>
  );
}

export function renderKinds(kinds: number): string {
  return KIND_CHECKBOXES.flatMap((k) => ((kinds & k.bit) === k.bit ? [k.label] : [])).join(", ");
}

const TYPE_BADGE: Record<string, string> = {
  personal: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  group: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  service: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  temp: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
  redirect: "border-border bg-muted text-muted-foreground",
};

export function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize",
        TYPE_BADGE[kind] ?? TYPE_BADGE.redirect,
      )}
    >
      {kind}
    </span>
  );
}
