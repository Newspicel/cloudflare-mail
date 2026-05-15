import { Mail } from "lucide-react";
import type React from "react";

export function CardShell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted p-6">
      <div className="w-full max-w-sm rounded-md border bg-card p-7 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Mail className="h-4 w-4" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-tight leading-none">cfmail</div>
            <div className="mt-1 text-[11px] text-muted-foreground">mail on Cloudflare</div>
          </div>
        </div>
        <h1 className="mb-5 text-[20px] font-semibold tracking-tight">{title}</h1>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  minLength?: number;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[12px] font-medium text-foreground">{label}</span>
      <input
        required={required}
        type={type}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-[13px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
      />
    </label>
  );
}

export function PrimaryButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="mb-2 w-full rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
    >
      {busy ? "…" : children}
    </button>
  );
}
