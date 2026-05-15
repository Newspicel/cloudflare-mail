import type React from "react";

export function CardShell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-background to-muted p-6">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-xl shadow-black/5">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground text-lg font-semibold">
            ✉
          </div>
          <div>
            <div className="text-lg font-semibold">cfmail</div>
            <div className="text-xs text-muted-foreground">mail on Cloudflare</div>
          </div>
        </div>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">{title}</h1>
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
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input
        required={required}
        type={type}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
      />
    </label>
  );
}

export function PrimaryButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="mb-3 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-95 disabled:opacity-50"
    >
      {busy ? "…" : children}
    </button>
  );
}
