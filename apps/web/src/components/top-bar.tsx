import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client.ts";
import { cn } from "@/lib/cn.ts";
import { meQuery, type SearchResult, searchQuery } from "@/lib/queries.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";
import { Logo } from "./logo.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

const SEARCH_DEBOUNCE_MS = 200;
const MIN_SEARCH_CHARS = 2;

export function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { data } = useQuery(meQuery);

  return (
    <header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-3 border-b bg-card px-3 pt-[env(safe-area-inset-top)] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))]">
      <div className="flex flex-1 items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className="shrink-0 md:hidden"
          aria-label="Toggle menu"
        >
          <Menu />
        </Button>
        <div className="flex items-center gap-2">
          <Logo className="h-7 w-7 rounded-md shadow-black/[0.06] shadow-sm" />
          <span className="hidden font-semibold text-[13px] tracking-tight sm:inline">cfmail</span>
        </div>
      </div>

      <SearchBox />

      <div className="flex flex-1 items-center justify-end">
        <AccountMenu email={data?.user?.email} name={data?.user?.name} image={data?.user?.image} />
      </div>
    </header>
  );
}

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AccountMenu({
  email,
  name,
  image,
}: {
  email?: string | null;
  name?: string | null;
  image?: string | null;
}) {
  const nav = useNavigate();
  const { theme, setTheme } = useTheme();
  const initial = name?.[0]?.toUpperCase() ?? email?.[0]?.toUpperCase() ?? "?";

  async function signOut() {
    await authClient.signOut();
    nav({ to: "/login" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="shrink-0 rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-ring/45"
        aria-label="Account menu"
      >
        <Avatar className="size-8 bg-primary/12 text-[12px] font-semibold text-primary transition hover:bg-primary/20">
          {image && <AvatarImage src={image} alt={name ?? email ?? ""} />}
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[13rem]">
        {email && (
          <>
            <DropdownMenuLabel className="truncate normal-case">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => nav({ to: "/app/settings" })}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEME_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            closeOnClick={false}
            onClick={() => setTheme(opt.value)}
          >
            <opt.icon /> {opt.label}
            {theme === opt.value && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

  const query = useQuery(searchQuery({ q: debounced }));
  const results = useMemo(() => query.data?.results ?? [], [query.data]);

  function go(result: SearchResult) {
    setOpen(false);
    setRaw("");
    inputRef.current?.blur();
    nav({
      to: "/app/m/$mailboxId/t/$threadId",
      params: { mailboxId: result.mailboxId, threadId: result.threadId },
      search: { view: "inbox" },
    });
  }

  function goToSearch() {
    const q = raw.trim();
    setOpen(false);
    inputRef.current?.blur();
    nav({ to: "/app/search", search: q ? { q } : {} });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
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
      else goToSearch();
    }
  }

  const showDropdown = open && raw.trim().length >= MIN_SEARCH_CHARS;

  return (
    <div ref={rootRef} className="relative w-full max-w-xl">
      <label className="flex items-center gap-2 rounded-full border bg-muted/60 px-3.5 py-1.5 text-[13px] text-muted-foreground transition focus-within:border-ring focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/30">
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
          aria-expanded={showDropdown}
          aria-controls="search-results"
          role="combobox"
        />
        <button
          type="button"
          onClick={goToSearch}
          className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label="Advanced search"
          title="Advanced search"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
        <kbd className="hidden shrink-0 items-center gap-0.5 rounded border bg-card px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground sm:inline-flex">
          /
        </kbd>
      </label>

      {showDropdown && (
        <div className="absolute top-full right-0 left-0 z-40 mt-2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-black/10 shadow-lg">
          {query.isLoading && !query.data ? (
            <div className="p-3 text-[12px] text-muted-foreground">Searching…</div>
          ) : query.isError ? (
            <div className="flex items-center justify-between gap-2 p-3 text-[12px]">
              <span className="text-destructive">Search failed</span>
              <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-[12px] text-muted-foreground">No matches</div>
          ) : (
            <ul id="search-results" className="max-h-[60vh] overflow-y-auto p-1">
              {results.map((r, i) => (
                <li key={r.messageId}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left text-[13px]",
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
          <button
            type="button"
            onClick={goToSearch}
            className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[12px] text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Search all mail for “<span className="font-medium text-foreground">{raw.trim()}</span>
              ”
            </span>
            <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0" />
          </button>
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
