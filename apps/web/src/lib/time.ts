import type { DateFormat, UserPrefs } from "@cfmail/shared";
import { useEffect, useState } from "react";

// ─── Date & time formatting ───────────────────────────────────────────────
//
// A user picks an explicit date layout (order + separator + numeric/named month
// + year width) and a 12/24-hour clock. Each `DateFormat` maps to a `DateSpec`
// that the pure renderers below assemble by hand — so the output is exactly the
// chosen pattern, not a country-locale guess. Defaults: 24.06.2026, 24-hour.
// `useDateTimeFmt` in lib/prefs.ts binds these to the live user prefs.

interface DateSpec {
  order: "dmy" | "mdy" | "ymd";
  /** numeric → zero-padded MM; short → "Jun"; long → "June". */
  month: "numeric" | "short" | "long";
  sep: string;
  year: "numeric" | "2-digit";
}

const DATE_SPECS: Record<DateFormat, DateSpec> = {
  "dmy-dot": { order: "dmy", month: "numeric", sep: ".", year: "numeric" },
  "dmy-dot-2": { order: "dmy", month: "numeric", sep: ".", year: "2-digit" },
  "dmy-slash": { order: "dmy", month: "numeric", sep: "/", year: "numeric" },
  "dmy-slash-2": { order: "dmy", month: "numeric", sep: "/", year: "2-digit" },
  "mdy-slash": { order: "mdy", month: "numeric", sep: "/", year: "numeric" },
  "mdy-slash-2": { order: "mdy", month: "numeric", sep: "/", year: "2-digit" },
  iso: { order: "ymd", month: "numeric", sep: "-", year: "numeric" },
  "d-mon-y": { order: "dmy", month: "short", sep: " ", year: "numeric" },
  "d-month-y": { order: "dmy", month: "long", sep: " ", year: "numeric" },
  "mon-d-y": { order: "mdy", month: "short", sep: " ", year: "numeric" },
  "month-d-y": { order: "mdy", month: "long", sep: " ", year: "numeric" },
};

const DEFAULT_DATE_FORMAT: DateFormat = "dmy-dot";

export interface DateTimeFmt {
  spec: DateSpec;
  hour12: boolean;
}

export function resolveDateTimeFmt(prefs: UserPrefs): DateTimeFmt {
  return {
    spec: DATE_SPECS[prefs.dateFormat ?? DEFAULT_DATE_FORMAT],
    hour12: (prefs.timeFormat ?? "24h") === "12h",
  };
}

/** Sample render of a format, for the settings picker labels. */
export function dateFormatExample(id: DateFormat): string {
  return renderDate(new Date(2026, 5, 24), DATE_SPECS[id], true);
}

function renderDate(d: Date, spec: DateSpec, withYear: boolean): string {
  const day = d.getDate();
  const year =
    spec.year === "2-digit" ? String(d.getFullYear()).slice(-2) : String(d.getFullYear());

  if (spec.month === "numeric") {
    const dd = String(day).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const seq =
      spec.order === "mdy"
        ? withYear
          ? [mm, dd, year]
          : [mm, dd]
        : spec.order === "ymd"
          ? withYear
            ? [year, mm, dd]
            : [mm, dd]
          : withYear
            ? [dd, mm, year]
            : [dd, mm];
    return seq.join(spec.sep);
  }

  // Named month ("Jun" / "June"); en-US gives a bare month name here.
  const month = d.toLocaleDateString("en-US", { month: spec.month });
  if (spec.order === "mdy") return withYear ? `${month} ${day}, ${year}` : `${month} ${day}`;
  if (spec.order === "ymd") return withYear ? `${year} ${month} ${day}` : `${month} ${day}`;
  return withYear ? `${day} ${month} ${year}` : `${day} ${month}`;
}

/** Clock time only, e.g. "14:30" or "2:30 PM". */
export function formatClock(d: Date, fmt: DateTimeFmt): string {
  return d.toLocaleTimeString("en-US", {
    hour: fmt.hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: fmt.hour12,
  });
}

/** Date + clock, e.g. a message header or print banner. */
export function formatDateTime(d: Date, fmt: DateTimeFmt): string {
  return `${renderDate(d, fmt.spec, true)}, ${formatClock(d, fmt)}`;
}

/** Compact list stamp: clock for today, date (year dropped if current) otherwise. */
export function formatStamp(iso: string, fmt: DateTimeFmt): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatClock(d, fmt);
  return renderDate(d, fmt.spec, d.getFullYear() !== now.getFullYear());
}

export function formatRemaining(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
