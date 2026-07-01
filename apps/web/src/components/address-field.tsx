import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";
import type { Contact } from "@/lib/queries.ts";
import { Field, fieldLabelClass } from "./ui/field.tsx";

const MAX_SUGGESTIONS = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Recipient {
  name?: string;
  address: string;
}

export interface RecipientsValue {
  items: Recipient[];
  input: string;
}

export function collectRecipients(v: RecipientsValue): Recipient[] {
  const out: Recipient[] = v.items.map((i) => ({ address: i.address, name: i.name }));
  for (const tok of v.input.split(/[\s,;]+/)) {
    const addr = tok.trim().toLowerCase();
    if (addr && !out.some((i) => i.address.toLowerCase() === addr)) out.push({ address: addr });
  }
  return out;
}

export function hasRecipients(v: RecipientsValue): boolean {
  return v.items.length > 0 || v.input.trim().length > 0;
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
  value: RecipientsValue;
  onChange: (v: RecipientsValue) => void;
  placeholder?: string;
  contacts: Contact[];
  trailing?: ReactNode;
}) {
  const { items, input } = value;
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const f = input.trim().toLowerCase();

  const used = new Set(items.map((i) => i.address.toLowerCase()));

  const matches: Contact[] = [];
  if (focused) {
    for (const ct of contacts) {
      const addr = ct.address.toLowerCase();
      if (used.has(addr)) continue;
      // eslint-disable-next-line react-doctor/js-set-map-lookups -- substring match on strings; membership already uses the `used` Set.
      if (f && !(addr.includes(f) || ct.name?.toLowerCase().includes(f))) continue;
      matches.push(ct);
      if (matches.length >= MAX_SUGGESTIONS) break;
    }
  }

  // Highlight cursor resets when the derived filter fragment `f` (from the `value` prop) changes; an arrow-key cursor can't be derived during render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset cursor as the typed fragment changes.
  useEffect(() => setHighlight(0), [f]); // react-doctor-disable-line no-adjust-state-on-prop-change

  const open = focused && matches.length > 0;
  const hi = highlight < matches.length ? highlight : 0;

  function commit(rec: Recipient) {
    const addr = rec.address.trim().toLowerCase();
    if (!addr) return;
    const next = used.has(addr) ? items : [...items, { ...rec, address: addr }];
    onChange({ items: next, input: "" });
  }

  function commitInput() {
    if (input.trim()) commit({ address: input });
  }

  // Splits pasted/typed separators into chips, keeping the last partial in the box.
  function handleInput(raw: string) {
    if (!/[\s,;]/.test(raw)) {
      onChange({ ...value, input: raw });
      return;
    }
    const parts = raw.split(/[\s,;]+/);
    const last = parts.pop() ?? "";
    const next = [...items];
    for (const p of parts) {
      const addr = p.trim().toLowerCase();
      if (addr && !next.some((i) => i.address.toLowerCase() === addr)) next.push({ address: addr });
    }
    onChange({ items: next, input: last });
  }

  return (
    <div className="relative">
      <Field
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        <span className={fieldLabelClass}>{label}</span>
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {items.map((it, idx) => {
            const valid = EMAIL_RE.test(it.address);
            return (
              <span
                key={it.address}
                title={it.name ? `${it.name} <${it.address}>` : it.address}
                className={cn(
                  "group inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-[12px] leading-5 transition-colors",
                  valid ? "bg-accent text-accent-foreground" : "bg-destructive/10 text-destructive",
                )}
              >
                <span className="truncate">{it.name || it.address}</span>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onChange({ ...value, items: items.filter((_, i) => i !== idx) })}
                  aria-label={`Remove ${it.address}`}
                  className="grid size-4 shrink-0 place-items-center rounded-full text-current/60 opacity-60 transition hover:bg-black/10 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/15"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
          <input
            ref={inputRef}
            value={input}
            aria-label={label}
            onChange={(e) => handleInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commitInput();
            }}
            onKeyDown={(e) => {
              if (open && (e.key === "Enter" || e.key === "Tab")) {
                const ct = matches[hi];
                if (ct) {
                  e.preventDefault();
                  commit(ct);
                  return;
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                commitInput();
              } else if (e.key === "ArrowDown" && open) {
                e.preventDefault();
                setHighlight((h) => (h + 1) % matches.length);
              } else if (e.key === "ArrowUp" && open) {
                e.preventDefault();
                setHighlight((h) => (h - 1 + matches.length) % matches.length);
              } else if (e.key === "Escape" && open) {
                e.preventDefault();
                setFocused(false);
              } else if (e.key === "Backspace" && input === "" && items.length) {
                e.preventDefault();
                onChange({ items: items.slice(0, -1), input: "" });
              }
            }}
            placeholder={items.length === 0 ? placeholder : ""}
            autoComplete="off"
            spellCheck={false}
            className="min-w-[10ch] flex-1 bg-transparent py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
          />
        </div>
        {trailing}
      </Field>
      {open && (
        <ul className="absolute top-full right-0 left-14 z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-black/10 shadow-lg">
          {matches.map((ct, i) => (
            <li key={ct.address}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(ct)}
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
