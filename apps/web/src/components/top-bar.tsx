import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Search, Settings, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client.ts";
import { cn } from "@/lib/cn.ts";
import { meQuery, type SearchResult, searchQuery } from "@/lib/queries.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";

const SEARCH_DEBOUNCE_MS = 200;
const MIN_SEARCH_CHARS = 2;

export function TopBar() {
  const { data } = useQuery(meQuery);
  const nav = useNavigate();
  const initial =
    data?.user?.name?.[0]?.toUpperCase() ?? data?.user?.email?.[0]?.toUpperCase() ?? "?";

  async function signOut() {
    await authClient.signOut();
    nav({ to: "/login" });
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold">
          ✉
        </div>
        <span className="text-[15px] font-semibold tracking-tight">cfmail</span>
      </div>

      <SearchBox />

      <ThemeToggle />

      <button
        type="button"
        className="rounded-full p-2 text-muted-foreground hover:bg-muted"
        onClick={() => nav({ to: "/app/settings" })}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="rounded-full p-2 text-muted-foreground hover:bg-muted"
        onClick={signOut}
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
      <div
        className="grid h-8 w-8 place-items-center rounded-full bg-accent text-sm font-medium text-accent-foreground"
        title={data?.user?.email}
      >
        {initial}
      </div>
    </header>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const order: Theme[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(theme) + 1) % order.length] ?? "system";
  const label =
    theme === "system" ? "System theme" : theme === "dark" ? "Dark theme" : "Light theme";
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <button
      type="button"
      className="rounded-full p-2 text-muted-foreground hover:bg-muted"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function SearchBox() {
  const nav = useNavigate();
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = raw.trim();
    if (trimmed.length < MIN_SEARCH_CHARS) {
      setDebounced("");
      return;
    }
    const handle = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [raw]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const query = useQuery(searchQuery(debounced));
  const results = useMemo(() => query.data?.results ?? [], [query.data]);

  useEffect(() => {
    setActiveIdx(0);
  }, []);

  function go(result: SearchResult) {
    setOpen(false);
    setRaw("");
    inputRef.current?.blur();
    nav({
      to: "/app/m/$mailboxId/t/$threadId",
      params: { mailboxId: result.mailboxId, threadId: result.threadId },
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[activeIdx];
      if (hit) go(hit);
    }
  }

  const showDropdown = open && raw.trim().length >= MIN_SEARCH_CHARS;

  return (
    <div ref={rootRef} className="relative mx-auto w-full max-w-2xl">
      <label className="flex items-center gap-2 rounded-full border bg-muted/60 px-4 py-2 text-sm text-muted-foreground focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/30">
        <Search className="h-4 w-4" />
        <input
          ref={inputRef}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search mail"
          className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          aria-label="Search mail"
        />
      </label>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          {query.isLoading && !query.data ? (
            <div className="p-4 text-xs text-muted-foreground">Searching…</div>
          ) : query.isError ? (
            <div className="p-4 text-xs text-destructive">Search failed</div>
          ) : results.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">No matches</div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {results.map((r, i) => (
                <li key={r.messageId}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-sm last:border-b-0",
                      i === activeIdx ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{r.fromName ?? r.fromAddr}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatWhen(r.receivedAt ?? r.sentAt)}
                      </span>
                    </div>
                    <div className="truncate text-[13px]">{r.subject || "(no subject)"}</div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">
                        {r.snippet || r.fromAddr}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                        {r.mailboxAddress}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
