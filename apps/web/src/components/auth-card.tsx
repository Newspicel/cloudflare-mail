import type React from "react";
import { useId } from "react";
import { Logo } from "./logo.tsx";
import { Button } from "./ui/button.tsx";
import { LabeledField } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";

export function CardShell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted p-6">
      <div className="w-full max-w-sm rounded-xl border bg-card p-7 shadow-black/[0.04] shadow-lg">
        <div className="mb-5 flex items-center gap-2.5">
          <Logo className="h-8 w-8 rounded-md shadow-black/[0.06] shadow-sm" />
          <div>
            <div className="font-semibold text-[15px] leading-none tracking-tight">cfmail</div>
            <div className="mt-1 text-[11px] text-muted-foreground">mail on Cloudflare</div>
          </div>
        </div>
        <h1 className="mb-5 font-semibold text-[20px] tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  minLength,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <LabeledField label={label} htmlFor={id} className="mb-3">
      <Input
        id={id}
        required={required}
        type={type}
        minLength={minLength}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </LabeledField>
  );
}

export function PrimaryButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 mb-2 w-full">
      {busy ? "…" : children}
    </Button>
  );
}
