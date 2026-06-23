import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn.ts";
import type { Contact } from "@/lib/queries.ts";

const FIELD_LABEL = "w-12 shrink-0 text-[11px] text-muted-foreground uppercase tracking-wider";
const FIELD_INPUT =
  "flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground";

const MAX_SUGGESTIONS = 8;

// Splits the recipient string into the committed prefix (everything up to and
// including the last comma/semicolon) and the address fragment being typed.
function splitToken(value: string): { before: string; fragment: string } {
  const idx = Math.max(value.lastIndexOf(","), value.lastIndexOf(";"));
  return idx === -1
    ? { before: "", fragment: value }
    : { before: value.slice(0, idx + 1), fragment: value.slice(idx + 1) };
}

export function AddressField({
  label,
  value,
  onChange,
  placeholder,
  contacts,
  trailing,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  contacts: Contact[];
  trailing?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const { before, fragment } = splitToken(value);
  const f = fragment.trim().toLowerCase();

  const used = useMemo(
    () =>
      new Set(
        value
          .split(/[,;]/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    [value],
  );

  const matches = useMemo(() => {
    if (!focused) return [];
    const out: Contact[] = [];
    for (const ct of contacts) {
      const addr = ct.address.toLowerCase();
      if (used.has(addr)) continue;
      if (f && !(addr.includes(f) || ct.name?.toLowerCase().includes(f))) continue;
      out.push(ct);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
  }, [contacts, focused, f, used]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset cursor as the typed fragment changes.
  useEffect(() => setHighlight(0), [f]);

  const open = focused && matches.length > 0;
  const hi = highlight < matches.length ? highlight : 0;

  function accept(ct: Contact) {
    const sep = before.trim() ? " " : "";
    onChange(`${before}${sep}${ct.address}, `);
    setHighlight(0);
  }

  return (
    <div className="relative">
      <label className="flex items-center gap-2 border-b py-1">
        <span className={FIELD_LABEL}>{label}</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % matches.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + matches.length) % matches.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              const ct = matches[hi];
              if (ct) {
                e.preventDefault();
                accept(ct);
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              setFocused(false);
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={FIELD_INPUT}
        />
        {trailing}
      </label>
      {open && (
        <ul className="absolute top-full right-0 left-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-black/10 shadow-lg">
          {matches.map((ct, i) => (
            <li key={ct.address}>
              <button
                type="button"
                // Keep focus on the input so the field's blur doesn't fire first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(ct)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full flex-col items-start gap-0 rounded-md px-2 py-1 text-left transition-colors",
                  i === hi && "bg-accent",
                )}
              >
                {ct.name && <span className="truncate text-[13px] leading-tight">{ct.name}</span>}
                <span
                  className={cn(
                    "truncate text-[12px] leading-tight",
                    ct.name ? "text-muted-foreground" : "text-[13px] text-foreground",
                  )}
                >
                  {ct.address}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
