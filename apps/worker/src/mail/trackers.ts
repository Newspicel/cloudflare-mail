// Tracker stripping for rendered message bodies. The image proxy hides *who*
// opened a mail (the sender sees Cloudflare's IP), but the beacon still fires,
// so the sender still learns *that* and *when* — and some beacons (HubSpot's
// open-duration pixel) deliberately hang to time the read. This pass runs
// before proxying and removes the request entirely. Three detectors:
//
//  1. Community tracker lists, fetched daily by the cron and kept in
//     `system_config` (zero-config), chosen for maintenance cadence:
//       - MailTrackerBlocker (github.com/apparition47/MailTrackerBlocker,
//         BSD-3): ~320 vendors as regex fragments, in its ObjC source.
//       - EasyPrivacy's email-tracker section (github.com/easylist/easylist,
//         GPLv3 / CC BY-SA 3.0): ~300 Adblock-syntax rules from the EasyList
//         maintainers.
//     Each is matched against the full image URL, so a vendor pixel on a
//     customer-branded CNAME is caught as long as its path shape is listed.
//  2. LOCAL_RULES below: shapes we have met in the wild that neither list
//     carries yet. Small on purpose — upstream is where these should end up.
//  3. A shape heuristic: a remote image laid out as 1×1, zero-sized or hidden
//     is invisible by construction, so its only purpose is the request. This
//     needs no list and catches the vendors the lists miss.
//
// False positives cost a spacer GIF; misses cost a read receipt the proxy has
// already stripped of IP and UA. Rendering-only — never touches stored mail.

import type { DB } from "@cfmail/db";
import { getConfig, setConfig } from "../config.ts";
import { CSS_URL_RE } from "./img-proxy.ts";

export const TRACKER_LIST_KEY = "tracker_list";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A failed fetch retries sooner than the daily cadence, but not every tick.
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_LIST_BYTES = 1024 * 1024;
// Upstream is data we execute as regex. Cap rule and input length so a
// pathological pattern (accidental or planted) can't burn the request budget.
const MAX_RULE_LEN = 300;
const MAX_URL_TEST_LEN = 2048;

interface RuleSet {
  substrings: string[];
  regexes: string[];
}
interface SourceRules extends RuleSet {
  fetchedAt: number;
}
interface StoredList {
  version: 1;
  nextRefreshAt: number;
  sources: Record<string, SourceRules>;
}
export interface TrackerRules {
  substrings: string[];
  regexes: RegExp[];
}

// ─── Our own findings ───────────────────────────────────────────────────────

// Checked against both upstream lists on 2026-09-13. Each entry names what it
// is so it can be removed once the vendor lands upstream.
const LOCAL_RULES: RuleSet = {
  substrings: [
    "eventtracking.hubapi.com/", // HubSpot open-duration beacon (self-redirecting)
  ],
  regexes: [
    "/__ptq\\.gif", // HubSpot analytics pixel
  ],
};

// Upstream over-blocks we undo: content CDNs that share a domain with a
// vendor's beacon host. A URL matching one of these is never a tracker.
const LOCAL_ALLOW: RegExp[] = [
  /createsend\d*\.com\/ei\//i, // Campaign Monitor hosted newsletter images
];

// ─── Upstream list parsers ──────────────────────────────────────────────────

// A source whose parse yields fewer rules than this is treated as broken (the
// upstream file format moved), so a silent parser drift never empties a list.
const MIN_RULES_PER_SOURCE = 20;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * MailTrackerBlocker keeps its list as an Objective-C dictionary literal:
 * `@"Vendor": @[ @"regex", @"regex" ],` inside `getTrackerDict`. Values are
 * ICU regexes matched case-insensitively — every current one is valid JS too.
 * Keys are followed by `:`, values by `,` or `]`, which is how the two are told
 * apart; commented-out lines are dropped first.
 */
export function parseMailTrackerBlocker(objc: string): RuleSet | null {
  const start = objc.indexOf("getTrackerDict {");
  if (start === -1) return null;
  const body = objc
    .slice(start)
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const regexes: string[] = [];
  for (const m of body.matchAll(/@"((?:[^"\\]|\\.)*)"\s*(?:\/\/[^\n]*\n\s*)?(?=[,\]])/g)) {
    // Undo ObjC string escaping: `\\` → `\`, `\"` → `"`.
    const pattern = m[1]!.replace(/\\(["\\])/g, "$1");
    if (pattern) regexes.push(pattern);
  }
  return regexes.length >= MIN_RULES_PER_SOURCE ? { substrings: [], regexes } : null;
}

// Adblock filter → regex source. The email section only uses plain patterns
// with `*` wildcards, the odd `^` separator and `$image`/`$third-party`
// options; anchors are handled for completeness.
function abpToRegex(rule: string): string {
  let p = rule;
  let domainAnchor = false;
  let startAnchor = false;
  let endAnchor = false;
  if (p.startsWith("||")) {
    domainAnchor = true;
    p = p.slice(2);
  } else if (p.startsWith("|")) {
    startAnchor = true;
    p = p.slice(1);
  }
  if (p.endsWith("|")) {
    endAnchor = true;
    p = p.slice(0, -1);
  }
  let re = p
    .split("*")
    .map((seg) => seg.split("^").map(escapeRegex).join("(?:[^\\w.%-]|$)"))
    .join(".*");
  if (domainAnchor) re = `^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?${re}`;
  if (startAnchor) re = `^${re}`;
  if (endAnchor) re = `${re}$`;
  return re;
}

/** EasyPrivacy email trackers: one Adblock rule per line; `!` comments. */
export function parseEasyPrivacy(txt: string): RuleSet | null {
  const regexes: string[] = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[") || line.startsWith("@@")) continue;
    if (line.includes("##") || line.includes("#@#")) continue; // element hiding
    const dollar = line.lastIndexOf("$");
    const pattern = dollar === -1 ? line : line.slice(0, dollar);
    if (pattern) regexes.push(abpToRegex(pattern));
  }
  return regexes.length >= MIN_RULES_PER_SOURCE ? { substrings: [], regexes } : null;
}

const SOURCES: { name: string; url: string; parse: (text: string) => RuleSet | null }[] = [
  {
    name: "mailtrackerblocker",
    url: "https://raw.githubusercontent.com/apparition47/MailTrackerBlocker/HEAD/Source/MTBBlockedMessage.m",
    parse: parseMailTrackerBlocker,
  },
  {
    name: "easyprivacy",
    url: "https://raw.githubusercontent.com/easylist/easylist/HEAD/easyprivacy/easyprivacy_general_emailtrackers.txt",
    parse: parseEasyPrivacy,
  },
];

// ─── Storage + refresh ──────────────────────────────────────────────────────

async function readStored(db: DB): Promise<{ raw: string; list: StoredList } | null> {
  const raw = await getConfig(db, TRACKER_LIST_KEY);
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as StoredList;
    return list.version === 1 && list.sources ? { raw, list } : null;
  } catch {
    return null;
  }
}

/**
 * Cron step: re-fetch every upstream list once the stored copy is due. A
 * source that fails keeps its previous rules, so an upstream outage never
 * empties the list; the whole set then retries on the shorter interval.
 */
export async function refreshTrackerList(
  db: DB,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const stored = (await readStored(db))?.list ?? null;
  if (stored && stored.nextRefreshAt > now.getTime()) return;
  const sources: Record<string, SourceRules> = { ...stored?.sources };
  // A source that was removed from SOURCES must not linger in storage.
  for (const name of Object.keys(sources)) {
    if (!SOURCES.some((s) => s.name === name)) delete sources[name];
  }
  let allOk = true;
  await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const res = await fetchImpl(src.url, {
          headers: { accept: "text/plain" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (Number(res.headers.get("content-length") ?? 0) > MAX_LIST_BYTES) {
          throw new Error("too large");
        }
        const text = await res.text();
        if (text.length > MAX_LIST_BYTES) throw new Error("too large");
        const parsed = src.parse(text);
        if (!parsed) throw new Error("unparseable");
        sources[src.name] = { ...parsed, fetchedAt: now.getTime() };
      } catch (err) {
        allOk = false;
        console.error(`tracker list fetch failed: ${src.name}`, err);
      }
    }),
  );
  const next: StoredList = {
    version: 1,
    nextRefreshAt: now.getTime() + (allOk ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS),
    sources,
  };
  await setConfig(db, TRACKER_LIST_KEY, JSON.stringify(next));
}

/** Merge rule sets into matchers, dropping over-long or uncompilable rules. */
export function compileRules(sets: Iterable<RuleSet>): TrackerRules {
  const substrings = new Set<string>();
  const regexes: RegExp[] = [];
  for (const set of sets) {
    for (const s of set.substrings) {
      if (s.length <= MAX_RULE_LEN) substrings.add(s.toLowerCase());
    }
    for (const r of set.regexes) {
      if (r.length > MAX_RULE_LEN) continue;
      try {
        regexes.push(new RegExp(r, "i"));
      } catch {
        // upstream typo — skip the one rule, keep the rest
      }
    }
  }
  return { substrings: [...substrings], regexes };
}

// The list changes at most daily; compile once per distinct stored value.
let compiled: { raw: string; rules: TrackerRules } | null = null;

/** Current matchers: LOCAL_RULES plus whatever the cron has fetched so far. */
export async function getTrackerRules(db: DB): Promise<TrackerRules> {
  const stored = await readStored(db);
  const raw = stored?.raw ?? "";
  if (compiled?.raw !== raw) {
    const sets = [LOCAL_RULES, ...Object.values(stored?.list.sources ?? {})];
    compiled = { raw, rules: compileRules(sets) };
  }
  return compiled.rules;
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** True when `raw` is an http(s) URL matching one of the list rules. */
export function isTrackerUrl(raw: string, rules: TrackerRules): boolean {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url) || url.length > MAX_URL_TEST_LEN) return false;
  if (LOCAL_ALLOW.some((rx) => rx.test(url))) return false;
  const lower = url.toLowerCase();
  if (rules.substrings.some((s) => lower.includes(s))) return true;
  return rules.regexes.some((rx) => rx.test(url));
}

function isRemote(raw: string | null): boolean {
  return raw !== null && /^\s*https?:\/\//i.test(raw);
}

// A length from an HTML attribute or CSS declaration as a px number; anything
// we can't read as plain px (percentages, `auto`, keywords) is unknown.
function px(v: string | null | undefined): number | null {
  if (v == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*(?:!important)?\s*$/i.exec(v);
  return m ? Number(m[1]) : null;
}

function cssProp(style: string, prop: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(style);
  return m?.[1]?.trim();
}

/**
 * Does this `<img>` have the shape of a beacon? Zero-sized or hidden images
 * paint nothing but still fetch; 1×1 is the canonical tracking pixel. A single
 * 1px dimension with the other unknown is left alone — that's a spacer or rule.
 */
export function looksLikePixel(attrs: {
  width: string | null;
  height: string | null;
  style: string | null;
  hidden: boolean;
}): boolean {
  if (attrs.hidden) return true;
  const style = attrs.style ?? "";
  if (style) {
    if (/(?:^|;)\s*display\s*:\s*none\b/i.test(style)) return true;
    if (/(?:^|;)\s*visibility\s*:\s*hidden\b/i.test(style)) return true;
  }
  // CSS beats the presentational attribute, as in the browser.
  const w = px(cssProp(style, "width")) ?? px(attrs.width);
  const h = px(cssProp(style, "height")) ?? px(attrs.height);
  if (w === 0 || h === 0) return true;
  return w !== null && h !== null && w <= 1 && h <= 1;
}

function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

// Replace tracker `url(…)`s in a CSS string with `none`, counting them.
function stripCssTrackers(css: string, rules: TrackerRules, count: { n: number }): string {
  return css.replace(CSS_URL_RE, (full, _q, u: string) => {
    if (!isTrackerUrl(u, rules)) return full;
    count.n++;
    return "none";
  });
}

/**
 * Remove tracking beacons from an HTML body: `<img>`s whose `src`/`srcset`
 * hits the tracker list or whose layout marks them as an invisible pixel, the
 * legacy `background` attribute, and CSS `url(…)` in `style` attributes and
 * `<style>` blocks that point at a listed tracker. Returns the cleaned markup
 * and how many were dropped, so the reader can be told. Uses HTMLRewriter —
 * the markup never touches a DOM.
 */
export async function stripTrackers(
  html: string,
  rules: TrackerRules,
): Promise<{ html: string; blocked: number }> {
  const count = { n: 0 };
  let styleBuf = "";
  const res = new HTMLRewriter()
    .on("img", {
      element(el) {
        const src = el.getAttribute("src");
        const srcset = el.getAttribute("srcset");
        const candidates = [
          ...(isRemote(src) ? [src as string] : []),
          ...(srcset ? srcsetUrls(srcset).filter(isRemote) : []),
        ];
        if (candidates.length === 0) return; // cid:/data:/relative — no request
        const tracker =
          candidates.some((u) => isTrackerUrl(u, rules)) ||
          looksLikePixel({
            width: el.getAttribute("width"),
            height: el.getAttribute("height"),
            style: el.getAttribute("style"),
            hidden: el.hasAttribute("hidden"),
          });
        if (tracker) {
          count.n++;
          el.remove();
        }
      },
    })
    .on("*", {
      element(el) {
        const style = el.getAttribute("style");
        if (style?.includes("url(")) {
          el.setAttribute("style", stripCssTrackers(style, rules, count));
        }
        const bg = el.getAttribute("background");
        if (bg && isTrackerUrl(bg, rules)) {
          count.n++;
          el.removeAttribute("background");
        }
      },
    })
    .on("style", {
      // Text arrives in chunks; buffer the whole node, then rewrite once.
      text(chunk) {
        styleBuf += chunk.text;
        if (chunk.lastInTextNode) {
          const rewritten = stripCssTrackers(styleBuf, rules, count);
          styleBuf = "";
          chunk.replace(rewritten, { html: true });
        } else {
          chunk.remove();
        }
      },
    })
    .transform(new Response(html));
  return { html: await res.text(), blocked: count.n };
}
