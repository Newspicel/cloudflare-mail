import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Mail, Monitor, Moon, Search, Settings, Sun } from "lucide-react";
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
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
          <Mail className="h-3.5 w-3.5" strokeWidth={2.5} />
        </div>
        <span className="text-[13px] font-semibold tracking-tight">cfmail</span>
        <span className="ml-2 hidden h-5 w-px bg-border sm:block" />
        <span className="hidden text-[12px] text-muted-foreground sm:block">Mail</span>
      </div>

      <SearchBox />

      <div className="flex items-center gap-0.5">
        <ThemeToggle />
        <IconButton onClick={() => nav({ to: "/app/settings" })} ariaLabel="Settings">
          <Settings className="h-4 w-4" />
        </IconButton>
        <IconButton onClick={signOut} ariaLabel="Sign out">
          <LogOut className="h-4 w-4" />
        </IconButton>
      </div>
      <button
        type="button"
        onClick={() => nav({ to: "/app/settings" })}
        className="ml-1 grid h-7 w-7 place-items-center rounded-full bg-accent text-[12px] font-medium text-accent-foreground hover:ring-2 hover:ring-ring/30"
        title={data?.user?.email}
      >
        {initial}
      </button>
    </header>
  );
}

function IconButton({
  onClick,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {children}
    </button>
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
    <IconButton onClick={() => setTheme(next)} ariaLabel={label}>
      <Icon className="h-4 w-4" />
    </IconButton>
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
    <div ref={rootRef} className="relative mx-auto w-full max-w-xl">
      <label className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-[13px] text-muted-foreground transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <Search className="h-3.5 w-3.5" />
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
          placeholder="Search mail…"
          className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          aria-label="Search mail"
        />
        <kbd className="hidden shrink-0 items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex">
          ⌘K
        </kbd>
      </label>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          {query.isLoading && !query.data ? (
            <div className="p-3 text-[12px] text-muted-foreground">Searching…</div>
          ) : query.isError ? (
            <div className="p-3 text-[12px] text-destructive">Search failed</div>
          ) : results.length === 0 ? (
            <div className="p-3 text-[12px] text-muted-foreground">No matches</div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {results.map((r, i) => (
                <li key={r.messageId}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-[13px] last:border-b-0",
                      i === activeIdx ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{r.fromName ?? r.fromAddr}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatWhen(r.receivedAt ?? r.sentAt)}
                      </span>
                    </div>
                    <div className="truncate text-[12px]">{r.subject || "(no subject)"}</div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-muted-foreground">
                        {r.snippet || r.fromAddr}
                      </span>
                      <span className="shrink-0 rounded border bg-muted px-1 text-[10px] text-muted-foreground">
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
