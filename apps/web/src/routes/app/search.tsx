import type { SearchFilters, SearchResultDto, SearchResultsDto } from "@cfmail/shared";
import { Flag, hasFlag } from "@cfmail/shared/flags";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronsUpDown,
  Inbox,
  Mails,
  Paperclip,
  Search,
  SearchX,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ToggleGroup, ToggleItem } from "@/components/ui/toggle-group.tsx";
import { EmptyState, ThreadListSkeleton } from "@/components/ui.tsx";
import { cn } from "@/lib/cn.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import {
  ALL_MAILBOXES,
  hasSearchCriteria,
  mailboxesQuery,
  type SearchFilterInput,
  searchQuery,
} from "@/lib/queries.ts";
import { type DateTimeFmt, formatStamp } from "@/lib/time.ts";

// Every filter lives in the URL so a search is shareable and back/forward works.
type SearchParams = Omit<Partial<SearchFilters>, "limit" | "page"> & { page?: number };

const SEARCH_IN: { value: NonNullable<SearchFilters["searchIn"]>; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "subject", label: "Subject" },
  { value: "from", label: "People" },
  { value: "body", label: "Body" },
];

const FOLDERS: {
  value: NonNullable<SearchFilters["folder"]>;
  label: string;
  icon: typeof Inbox;
}[] = [
  { value: "any", label: "All folders", icon: Mails },
  { value: "inbox", label: "Inbox", icon: Inbox },
  { value: "sent", label: "Sent", icon: ArrowUpFromLine },
  { value: "marked", label: "Marked", icon: Star },
  { value: "spam", label: "Spam", icon: ShieldAlert },
  { value: "trash", label: "Trash", icon: Trash2 },
];

const PAGE_SIZE = 25;
const MAX_RESULTS = 100; // matches the server-side limit cap

export const Route = createFileRoute("/app/search")({
  validateSearch: (search: Record<string, unknown>): SearchParams => clean(search),
  component: SearchPage,
});

function str(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
}

// `mailboxId` is a comma-separated list of ids ("" / "all" = every readable mailbox).
function parseMailboxIds(v: string | undefined): string[] {
  if (!v || v === ALL_MAILBOXES) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalize raw URL params into a typed, default-stripped filter object.
function clean(s: Record<string, unknown>): SearchParams {
  const out: SearchParams = {};
  if (str(s.q)) out.q = str(s.q);
  if (s.searchIn === "subject" || s.searchIn === "from" || s.searchIn === "body")
    out.searchIn = s.searchIn;
  for (const k of ["from", "to", "subject", "exclude", "after", "before", "mailboxId"] as const) {
    const v = str(s[k]);
    if (v) out[k] = v;
  }
  if (s.direction === "in" || s.direction === "out") out.direction = s.direction;
  if (s.hasAttachment === true || s.hasAttachment === "true") out.hasAttachment = true;
  if (
    s.folder === "inbox" ||
    s.folder === "sent" ||
    s.folder === "marked" ||
    s.folder === "spam" ||
    s.folder === "trash"
  )
    out.folder = s.folder;
  const page = Number(s.page);
  if (Number.isInteger(page) && page > 0) out.page = page;
  return out;
}

function SearchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const mailboxes = useQuery(mailboxesQuery);

  // Inputs are driven by local state for snappiness; committed to the URL on a
  // debounce. `lastWritten` lets us tell our own writes from external nav (back
  // button) so we can resync without a feedback loop.
  const [form, setForm] = useState<SearchParams>(search);
  const lastWritten = useRef(JSON.stringify(search));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queryRef.current?.focus();
  }, []);

  useEffect(() => {
    const key = JSON.stringify(search);
    if (key !== lastWritten.current) {
      lastWritten.current = key;
      setForm(search);
    }
  }, [search]);

  useEffect(() => {
    const next = clean({ ...form });
    const key = JSON.stringify(next);
    if (key === lastWritten.current) return;
    const handle = setTimeout(() => {
      lastWritten.current = key;
      navigate({ search: next, replace: true });
    }, 300);
    return () => clearTimeout(handle);
  }, [form, navigate]);

  // Query off the debounced URL `search` (not the live `form`) so requests fire
  // after the 300ms settle, not on every keystroke.
  const filters: SearchFilterInput = { ...search, limit };
  const query = useQuery(searchQuery(filters));
  const results = query.data?.results ?? [];

  function set<K extends keyof SearchParams>(key: K, value: SearchParams[K]) {
    setLimit(PAGE_SIZE);
    setForm((prev) => {
      const next = { ...prev };
      if (value === undefined || value === "" || value === false) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  const activeChips = buildChips(form, mailboxes.data?.mailboxes);
  const filterCount = activeChips.length;

  const mailboxList = mailboxes.data?.mailboxes ?? [];
  const selectedMailboxIds = parseMailboxIds(form.mailboxId);

  function setMailboxIds(ids: string[]) {
    // Keep the URL value in the same order the mailboxes are listed.
    const ordered = mailboxList.filter((m) => ids.includes(m.id)).map((m) => m.id);
    set("mailboxId", ordered.length ? ordered.join(",") : undefined);
  }

  function toggleMailbox(id: string, on: boolean) {
    const next = new Set(selectedMailboxIds);
    if (on) next.add(id);
    else next.delete(id);
    setMailboxIds([...next]);
  }

  const scopeText =
    selectedMailboxIds.length === 0
      ? "across all mailboxes"
      : selectedMailboxIds.length === 1
        ? "in 1 mailbox"
        : `across ${selectedMailboxIds.length} mailboxes`;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Search header */}
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-full border bg-muted/60 px-4 py-2 text-[14px] transition focus-within:border-ring focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/30">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={queryRef}
              value={form.q ?? ""}
              onChange={(e) => set("q", e.target.value)}
              placeholder="Search all mail…"
              className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Search query"
            />
            {form.q && (
              <button
                type="button"
                onClick={() => set("q", undefined)}
                className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear query"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button variant="outline" className="gap-1.5">
                  <SlidersHorizontal />
                  Filters
                  {filterCount > 0 && (
                    <Badge variant="primary" className="px-1.5">
                      {filterCount}
                    </Badge>
                  )}
                </Button>
              }
            />
            <PopoverContent align="end" className="w-[22rem] p-3">
              <AdvancedPanel form={form} set={set} />
            </PopoverContent>
          </Popover>
        </div>

        {/* Quick filter row */}
        <div className="mx-auto mt-2.5 flex max-w-3xl flex-wrap items-center gap-2">
          <Select
            value={form.folder ?? "any"}
            onValueChange={(v) =>
              set("folder", v === "any" ? undefined : (v as SearchParams["folder"]))
            }
          >
            <SelectTrigger aria-label="Folder" className="h-7 w-auto gap-1.5 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FOLDERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Segmented
            value={form.direction ?? "any"}
            onChange={(v) => set("direction", v === "any" ? undefined : (v as "in" | "out"))}
            options={[
              { value: "any", label: "Any", icon: Mails },
              { value: "in", label: "Received", icon: ArrowDownToLine },
              { value: "out", label: "Sent", icon: ArrowUpFromLine },
            ]}
          />

          <div className="flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] text-muted-foreground shadow-sm">
            <Paperclip className="h-3.5 w-3.5" />
            Attachments
            <Switch
              checked={form.hasAttachment ?? false}
              onCheckedChange={(v) => set("hasAttachment", v || undefined)}
              className="ml-1"
              aria-label="Has attachments"
            />
          </div>

          <MailboxScope
            className="sm:ml-auto"
            mailboxes={mailboxList}
            selected={selectedMailboxIds}
            onToggle={toggleMailbox}
            onClear={() => setMailboxIds([])}
          />
        </div>

        {/* Active filter chips */}
        {activeChips.length > 0 && (
          <div className="mx-auto mt-2.5 flex max-w-3xl flex-wrap items-center gap-1.5">
            {activeChips.map((chip) => (
              <button
                key={chip.mailboxId ?? chip.key}
                type="button"
                onClick={() =>
                  chip.mailboxId ? toggleMailbox(chip.mailboxId, false) : set(chip.key, undefined)
                }
                className="group"
                aria-label={`Remove ${chip.label}`}
              >
                <Badge
                  variant="outline"
                  className="gap-1 pr-1 transition-colors group-hover:border-foreground/30"
                >
                  {chip.label}
                  <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                </Badge>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setLimit(PAGE_SIZE);
                setForm({});
              }}
              className="ml-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          <Results
            query={query}
            results={results}
            active={hasSearchCriteria(filters)}
            scopeText={scopeText}
            hasMore={query.data?.hasMore ?? false}
            shownLimit={limit}
            atCap={limit >= MAX_RESULTS}
            onLoadMore={() => setLimit((l) => Math.min(l + PAGE_SIZE, MAX_RESULTS))}
          />
        </div>
      </div>
    </div>
  );
}

type SetFn = <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => void;

function AdvancedPanel({ form, set }: { form: SearchParams; set: SetFn }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] font-medium text-foreground">Advanced filters</div>
      <Field label="Search in">
        <Select
          value={form.searchIn ?? "all"}
          onValueChange={(v) =>
            set("searchIn", v === "all" ? undefined : (v as SearchParams["searchIn"]))
          }
        >
          <SelectTrigger aria-label="Search in">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEARCH_IN.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="From">
          <Input
            value={form.from ?? ""}
            onChange={(e) => set("from", e.target.value)}
            placeholder="name or email"
          />
        </Field>
        <Field label="To">
          <Input
            value={form.to ?? ""}
            onChange={(e) => set("to", e.target.value)}
            placeholder="recipient"
          />
        </Field>
        <Field label="Subject">
          <Input
            value={form.subject ?? ""}
            onChange={(e) => set("subject", e.target.value)}
            placeholder="words in subject"
          />
        </Field>
        <Field label="Exclude">
          <Input
            value={form.exclude ?? ""}
            onChange={(e) => set("exclude", e.target.value)}
            placeholder="words to omit"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="After">
          <Input
            type="date"
            value={form.after ?? ""}
            onChange={(e) => set("after", e.target.value || undefined)}
          />
        </Field>
        <Field label="Before">
          <Input
            type="date"
            value={form.before ?? ""}
            onChange={(e) => set("before", e.target.value || undefined)}
          />
        </Field>
      </div>
      <Separator />
      <p className="text-[11px] text-muted-foreground">
        Tip: prefix a word with <code className="rounded bg-muted px-1">-</code> in the search box
        to exclude it.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon: typeof Inbox }[];
}) {
  return (
    <ToggleGroup value={value} onValueChange={onChange} className="h-7 bg-card">
      {options.map((o) => (
        <ToggleItem key={o.value} value={o.value} variant="accent" className="px-2 py-0.5">
          <o.icon />
          {o.label}
        </ToggleItem>
      ))}
    </ToggleGroup>
  );
}

function MailboxScope({
  className,
  mailboxes,
  selected,
  onToggle,
  onClear,
}: {
  className?: string;
  mailboxes: { id: string; address: string; displayName?: string | null }[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  onClear: () => void;
}) {
  const count = selected.length;
  const label =
    count === 0
      ? "All mailboxes"
      : count === 1
        ? (mailboxes.find((m) => m.id === selected[0])?.address ?? "1 mailbox")
        : `${count} mailboxes`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Filter by mailbox"
            className={cn(
              "flex h-7 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] shadow-sm transition-colors hover:bg-accent/60",
              count > 0 ? "text-foreground" : "text-muted-foreground",
              className,
            )}
          >
            <Inbox className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent align="end" className="w-[16rem] max-w-[calc(100vw-2rem)] p-1.5">
        <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">Mailboxes</div>
        <div className="max-h-64 overflow-y-auto">
          <button
            type="button"
            onClick={onClear}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
          >
            <Checkbox checked={count === 0} tabIndex={-1} className="pointer-events-none" />
            <span className="truncate">All mailboxes</span>
          </button>
          {mailboxes.map((m) => {
            const on = selected.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onToggle(m.id, !on)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
              >
                <Checkbox checked={on} tabIndex={-1} className="pointer-events-none" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{m.address}</span>
                  {m.displayName && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {m.displayName}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Results({
  query,
  results,
  active,
  scopeText,
  hasMore,
  shownLimit,
  atCap,
  onLoadMore,
}: {
  query: UseQueryResult<SearchResultsDto>;
  results: SearchResultDto[];
  active: boolean;
  scopeText: string;
  hasMore: boolean;
  shownLimit: number;
  atCap: boolean;
  onLoadMore: () => void;
}) {
  if (!active) {
    return (
      <EmptyState
        icon={Search}
        title="Search your mail"
        hint="Find messages by sender, recipient, subject, or anything in the body. Use the filters to narrow by folder, date, or attachments."
        className="mt-16"
      />
    );
  }
  if (query.isLoading) return <ThreadListSkeleton />;
  if (query.isError) {
    return (
      <EmptyState
        icon={SearchX}
        title="Search failed"
        hint="Something went wrong. Try again."
        action={
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        }
        className="mt-16"
      />
    );
  }
  if (results.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No matches"
        hint="Try broadening your filters or searching different terms."
        className="mt-16"
      />
    );
  }

  return (
    <div className="py-2">
      <div className="px-4 py-1 text-[11px] text-muted-foreground">
        {results.length}
        {hasMore ? "+" : ""} result{results.length === 1 ? "" : "s"} {scopeText}
      </div>
      <ul>
        {results.map((r) => (
          <ResultRow key={r.messageId} r={r} />
        ))}
      </ul>
      {hasMore && results.length >= shownLimit && !atCap && (
        <div className="flex justify-center py-3">
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={query.isFetching}>
            {query.isFetching ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      {hasMore && atCap && (
        <div className="py-3 text-center text-[11px] text-muted-foreground">
          Showing the first {MAX_RESULTS}. Refine your filters to narrow the results.
        </div>
      )}
    </div>
  );
}

function ResultRow({ r }: { r: SearchResultDto }) {
  const fmt = useDateTimeFmt();
  const unread = !hasFlag(r.flags, Flag.SEEN);
  const who = r.direction === "out" ? `To ${r.fromName ?? r.fromAddr}` : (r.fromName ?? r.fromAddr);
  return (
    <li className="border-b last:border-b-0">
      <Link
        to="/app/m/$mailboxId/t/$threadId"
        params={{ mailboxId: r.mailboxId, threadId: r.threadId }}
        search={{ view: "inbox" }}
        className="flex flex-col gap-0.5 px-4 py-2.5 text-[13px] hover:bg-muted/60"
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate", unread && "font-semibold")}>{who}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatWhen(r.receivedAt ?? r.sentAt, fmt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[12px]",
              unread ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {r.subject || "(no subject)"}
          </span>
          {r.hasAttachments && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-muted-foreground">
            {r.snippet || r.fromAddr}
          </span>
          <span className="shrink-0 rounded border bg-muted px-1 text-[10px] text-muted-foreground">
            {r.mailboxAddress}
          </span>
        </div>
      </Link>
    </li>
  );
}

interface Chip {
  key: keyof SearchParams;
  label: string;
  // Set for per-mailbox chips so removing one only drops that id, not the whole scope.
  mailboxId?: string;
}

function buildChips(form: SearchParams, mailboxes?: { id: string; address: string }[]): Chip[] {
  const chips: Chip[] = [];
  if (form.searchIn) chips.push({ key: "searchIn", label: `in: ${form.searchIn}` });
  if (form.from) chips.push({ key: "from", label: `from: ${form.from}` });
  if (form.to) chips.push({ key: "to", label: `to: ${form.to}` });
  if (form.subject) chips.push({ key: "subject", label: `subject: ${form.subject}` });
  if (form.exclude) chips.push({ key: "exclude", label: `exclude: ${form.exclude}` });
  if (form.direction)
    chips.push({ key: "direction", label: form.direction === "in" ? "received" : "sent" });
  if (form.hasAttachment) chips.push({ key: "hasAttachment", label: "has attachment" });
  if (form.folder) chips.push({ key: "folder", label: `folder: ${form.folder}` });
  if (form.after) chips.push({ key: "after", label: `after: ${form.after}` });
  if (form.before) chips.push({ key: "before", label: `before: ${form.before}` });
  for (const id of parseMailboxIds(form.mailboxId)) {
    const addr = mailboxes?.find((m) => m.id === id)?.address ?? "mailbox";
    chips.push({ key: "mailboxId", label: addr, mailboxId: id });
  }
  return chips;
}

function formatWhen(iso: string | null, fmt: DateTimeFmt): string {
  return iso ? formatStamp(iso, fmt) : "";
}
