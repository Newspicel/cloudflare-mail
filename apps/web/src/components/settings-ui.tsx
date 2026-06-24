import { Check, ChevronDown, Copy } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn.ts";

// Shared building blocks for the Settings surface. Every settings card —
// profile, appearance, rules, mailboxes, PGP — composes these so the page reads
// as one system: same card shell, header weight, field labels, and spacing.

/** Outer card surface. Used directly when a card needs a custom body layout. */
export const cardClass = "scroll-mt-8 overflow-hidden rounded-lg border bg-card shadow-sm";

/** Field control base — inputs, selects, and textareas all share this look. */
export const fieldClass =
  "w-full rounded-md border bg-background px-2.5 py-1.5 text-[13px] text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50";

/** Card header: title (+ optional description) on the left, action on the right. */
export function CardHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b bg-muted/25 px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

/** Full card: header + body, with an optional right-aligned footer action bar. */
export function Section({
  id,
  title,
  description,
  action,
  footer,
  children,
  contentClassName,
}: {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <section id={id} className={cardClass}>
      <CardHeader title={title} description={description} action={action} />
      <div className={cn("px-5 py-4", contentClassName)}>{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-2 border-t bg-muted/25 px-5 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}

/** Small uppercase label that opens a sub-group inside a card. */
export function GroupLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

/** A bordered region inside a card — used to split a card into labelled blocks. */
export function Region({
  label,
  description,
  children,
  className,
}: {
  label?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-t px-5 py-4 first:border-t-0", className)}>
      {label && (
        <div className="mb-3">
          <GroupLabel>{label}</GroupLabel>
          {description && (
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** Stacked field: label on top, control, then an optional hint below. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[12px] font-medium text-foreground">
          {label}
        </label>
      )}
      {children}
      {hint && <p className="text-[12px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Inline row: label/hint on the left, a control pinned to the right. */
export function Row({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0 text-[13px]">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={cn(fieldClass, "h-auto leading-normal", props.className)} />
  );
}

/** Native select styled to match the field controls, with a chevron affordance. */
export function NativeSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          fieldClass,
          "cursor-pointer appearance-none pr-8 disabled:cursor-not-allowed",
          props.className,
        )}
      />
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/** Segmented control for picking one of a few enum values. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 shadow-sm">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cn(
            "rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50",
            value === v
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy failed");
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition hover:bg-muted"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}
