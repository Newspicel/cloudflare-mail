import type { SearchFilters, SearchResultDto, SearchResultsDto } from "@cfmail/shared";
import { Flag, hasFlag } from "@cfmail/shared/flags";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
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
import { inputClass } from "@/components/ui/input.tsx";
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
import { EmptyState, ThreadListSkeleton } from "@/components/ui.tsx";
import { cn } from "@/lib/cn.ts";
import {
  ALL_MAILBOXES,
  hasSearchCriteria,
  mailboxesQuery,
  type SearchFilterInput,
  searchQuery,
} from "@/lib/queries.ts";

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

  const filters: SearchFilterInput = { ...clean({ ...form }), limit };
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
  const scopedMailbox = form.mailboxId && form.mailboxId !== ALL_MAILBOXES ? form.mailboxId : null;

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

          <div className="ml-auto flex items-center gap-2">
            <div className="flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] text-muted-foreground shadow-sm">
              This mailbox only
              <Switch
                checked={Boolean(scopedMailbox)}
                onCheckedChange={(on) =>
                  set("mailboxId", on ? (mailboxes.data?.mailboxes[0]?.id ?? undefined) : undefined)
                }
                className="ml-1"
                aria-label="Scope to one mailbox"
              />
            </div>
            {scopedMailbox && (
              <Select value={scopedMailbox} onValueChange={(v) => set("mailboxId", v as string)}>
                <SelectTrigger
                  aria-label="Mailbox"
                  className="h-7 w-auto max-w-[14rem] gap-1.5 text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(mailboxes.data?.mailboxes ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        {/* Active filter chips */}
        {activeChips.length > 0 && (
          <div className="mx-auto mt-2.5 flex max-w-3xl flex-wrap items-center gap-1.5">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => set(chip.key, undefined)}
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
            scopedAll={!scopedMailbox}
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
          <input
            className={inputClass}
            value={form.from ?? ""}
            onChange={(e) => set("from", e.target.value)}
            placeholder="name or email"
          />
        </Field>
        <Field label="To">
          <input
            className={inputClass}
            value={form.to ?? ""}
            onChange={(e) => set("to", e.target.value)}
            placeholder="recipient"
          />
        </Field>
        <Field label="Subject">
          <input
            className={inputClass}
            value={form.subject ?? ""}
            onChange={(e) => set("subject", e.target.value)}
            placeholder="words in subject"
          />
        </Field>
        <Field label="Exclude">
          <input
            className={inputClass}
            value={form.exclude ?? ""}
            onChange={(e) => set("exclude", e.target.value)}
            placeholder="words to omit"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="After">
          <input
            type="date"
            className={inputClass}
            value={form.after ?? ""}
            onChange={(e) => set("after", e.target.value || undefined)}
          />
        </Field>
        <Field label="Before">
          <input
            type="date"
            className={inputClass}
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
    <div className="flex h-7 items-center rounded-md border bg-card p-0.5 shadow-sm">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-[12px] transition-colors",
              active
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <o.icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Results({
  query,
  results,
  active,
  scopedAll,
  hasMore,
  shownLimit,
  atCap,
  onLoadMore,
}: {
  query: UseQueryResult<SearchResultsDto>;
  results: SearchResultDto[];
  active: boolean;
  scopedAll: boolean;
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
        {hasMore ? "+" : ""} result{results.length === 1 ? "" : "s"}{" "}
        {scopedAll ? "across all mailboxes" : "in this mailbox"}
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
            {formatWhen(r.receivedAt ?? r.sentAt)}
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
  if (form.mailboxId) {
    const addr = mailboxes?.find((m) => m.id === form.mailboxId)?.address ?? "mailbox";
    chips.push({ key: "mailboxId", label: addr });
  }
  return chips;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
