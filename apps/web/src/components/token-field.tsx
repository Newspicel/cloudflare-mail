import { X } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/cn.ts";

const SPLIT = /[\s,;]+/;

export interface TokenFieldProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  // Clean/validate a raw entry; return null to reject it. Defaults to a trim.
  normalize?: (raw: string) => string | null;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}

// Bubble/chip input: each committed value renders as a removable pill, the way
// recipient addresses do in compose. Commits on Enter / comma / space / blur,
// splits pasted lists, and removes the last chip on Backspace when empty.
export function TokenField({
  value,
  onChange,
  placeholder,
  normalize = (raw) => raw.trim() || null,
  ariaLabel,
  className,
  disabled,
  inputRef,
}: TokenFieldProps) {
  const localRef = useRef<HTMLInputElement>(null);

  function add(raw: string) {
    const parts = raw.split(SPLIT);
    const next = [...value];
    for (const part of parts) {
      const token = normalize(part);
      if (token && !next.includes(token)) next.push(token);
    }
    if (next.length !== value.length) onChange(next);
  }

  function commitInput() {
    const el = localRef.current;
    if (el?.value.trim()) {
      add(el.value);
      el.value = "";
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const el = e.currentTarget;
    if ((e.key === "Enter" || e.key === ",") && el.value.trim()) {
      e.preventDefault();
      add(el.value);
      el.value = "";
    } else if (e.key === "Backspace" && el.value === "" && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the field focuses its input
    <div
      className={cn(
        "flex w-full flex-wrap items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-[13px] shadow-sm outline-none transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !disabled) localRef.current?.focus();
      }}
    >
      {value.map((token, idx) => (
        <span
          key={token}
          title={token}
          className="group inline-flex max-w-full items-center gap-1 rounded-full bg-accent py-0.5 pr-1 pl-2.5 text-[12px] text-accent-foreground leading-5"
        >
          <span className="truncate">{token}</span>
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(value.filter((_, i) => i !== idx))}
            aria-label={`Remove ${token}`}
            className="grid size-4 shrink-0 place-items-center rounded-full text-current/60 opacity-60 transition hover:bg-black/10 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/15"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={(el) => {
          localRef.current = el;
          if (typeof inputRef === "function") inputRef(el);
          else if (inputRef) inputRef.current = el;
        }}
        disabled={disabled}
        placeholder={value.length === 0 ? placeholder : ""}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onBlur={commitInput}
        className="min-w-[8ch] flex-1 bg-transparent py-0.5 leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}
