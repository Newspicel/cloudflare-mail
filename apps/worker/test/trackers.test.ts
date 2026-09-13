import { systemConfig } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config.ts";
import {
  compileRules,
  getTrackerRules,
  isTrackerUrl,
  looksLikePixel,
  parseTrockerLists,
  parseUglyEmailList,
  refreshTrackerList,
  stripTrackers,
  TRACKER_LIST_KEY,
} from "../src/mail/trackers.ts";
import { applyMigrationsOnce, db, resetDb } from "./support/app.ts";

// Excerpts in the exact shape of the upstream files.
const TROCKER_JS = `
export async function getOpenTrackerList(forceDefault = false) {
	let openTrackers;
	openTrackers = [
		{
			name: 'YW',
			domains: ['t.yesware.com/t'],
			patterns: [],
		},
		{
			name: 'MC',
			domains: ['mandrillapp.com/track', 'list-manage.com/track'],
			patterns: ['*://*.mandrillapp.com/track/open*', '*://*.list-manage.com/track/open*'],
		},
	];
	return openTrackers;
}
export async function getClickTrackerList() {
	let clickTrackers = [{ name: 'CC', domains: ['r20.rs6.net/tn.jsp'], patterns: [] }];
	return clickTrackers;
}
`;
const UGLY_TXT = [
  "SendGrid@@=\\/wf\\/open\\?upn=",
  "Hubspot@@=t\\.hubspotemail\\.net|\\/e2t\\/(o|c|to)\\/",
  "Constant Contact@@=\\.net\\/on\\.jsp\\?",
  "",
].join("\n");

const RULES = compileRules([parseTrockerLists(TROCKER_JS)!, parseUglyEmailList(UGLY_TXT)!]);

describe("upstream list parsers", () => {
  it("reads Trocker's open-tracker block only, as substrings + match patterns", () => {
    const parsed = parseTrockerLists(TROCKER_JS)!;
    expect(parsed.substrings).toEqual([
      "t.yesware.com/t",
      "mandrillapp.com/track",
      "list-manage.com/track",
    ]);
    expect(parsed.regexes).toHaveLength(2);
    expect(parsed.regexes[0]).toBe("^.*:\\/\\/.*\\.mandrillapp\\.com\\/track\\/open.*$");
    expect(parsed.substrings).not.toContain("r20.rs6.net/tn.jsp"); // click list
    expect(parseTrockerLists("nothing here")).toBeNull();
  });

  it("reads Ugly Email's NAME@@=REGEX lines", () => {
    expect(parseUglyEmailList(UGLY_TXT)!.regexes).toEqual([
      "\\/wf\\/open\\?upn=",
      "t\\.hubspotemail\\.net|\\/e2t\\/(o|c|to)\\/",
      "\\.net\\/on\\.jsp\\?",
    ]);
    expect(parseUglyEmailList("# no entries")).toBeNull();
  });

  it("compiles rules and drops broken or oversized ones", () => {
    const rules = compileRules([
      { substrings: ["A.Example/T", "x".repeat(400)], regexes: ["(unclosed", "\\/ok\\/", "y".repeat(400)] },
    ]);
    expect(rules.substrings).toEqual(["a.example/t"]);
    expect(rules.regexes).toHaveLength(1);
  });
});

describe("isTrackerUrl", () => {
  it("matches list substrings, match patterns and regexes against the full URL", () => {
    expect(isTrackerUrl("https://T.Yesware.com/t/abc", RULES)).toBe(true); // substring, any case
    expect(isTrackerUrl("https://x.list-manage.com/track/open.php?u=1", RULES)).toBe(true);
    expect(isTrackerUrl("https://news.example.com/wf/open?upn=abc", RULES)).toBe(true); // regex, CNAMEd host
    expect(isTrackerUrl("https://email.example.com/e2t/o/abc", RULES)).toBe(true);
    expect(isTrackerUrl("https://r20.rs6.net/on.jsp?ca=1", RULES)).toBe(true);
  });

  it("leaves ordinary content images and non-http sources alone", () => {
    expect(isTrackerUrl("https://cdn.example.com/hero.png", RULES)).toBe(false);
    expect(isTrackerUrl("https://images.example.com/track-and-field.jpg", RULES)).toBe(false);
    expect(isTrackerUrl("cid:logo@example", RULES)).toBe(false);
    expect(isTrackerUrl("data:image/gif;base64,R0lGOD", RULES)).toBe(false);
    expect(isTrackerUrl("not a url", RULES)).toBe(false);
    expect(isTrackerUrl(`https://x.list-manage.com/track/${"a".repeat(3000)}`, RULES)).toBe(false); // over the test cap
  });
});

const img = (o: Partial<Parameters<typeof looksLikePixel>[0]>) =>
  looksLikePixel({ width: null, height: null, style: null, hidden: false, ...o });

describe("looksLikePixel", () => {
  it("flags 1×1, zero-sized and hidden images", () => {
    expect(img({ width: "1", height: "1" })).toBe(true);
    expect(img({ style: "width:1px;height:1px;border:0" })).toBe(true);
    expect(img({ width: "0" })).toBe(true);
    expect(img({ style: "display: none" })).toBe(true);
    expect(img({ style: "visibility:hidden" })).toBe(true);
    expect(img({ hidden: true })).toBe(true);
    // CSS overrides the attribute, as in a browser.
    expect(img({ width: "600", height: "40", style: "width:1px;height:1px" })).toBe(true);
  });

  it("keeps spacers, rules and normal images", () => {
    expect(img({ width: "1", height: "20" })).toBe(false); // vertical spacer
    expect(img({ width: "600", height: "1" })).toBe(false); // hairline rule
    expect(img({ width: "1" })).toBe(false); // other dimension unknown
    expect(img({ width: "600", height: "200" })).toBe(false);
    expect(img({ style: "width:100%;height:auto" })).toBe(false);
    expect(img({})).toBe(false);
  });
});

describe("stripTrackers", () => {
  it("removes listed and pixel-shaped images, keeps content images, and counts", async () => {
    const html =
      `<p>Hi</p>` +
      `<img src="https://email.example.com/e2t/o/abc" alt="">` +
      `<img src="https://cdn.example.com/px.gif?u=1" width="1" height="1">` +
      `<img src="https://cdn.example.com/hero.png" width="600" height="200">` +
      `<img src="cid:logo" width="1" height="1">` +
      `<img src="https://cdn.example.com/sp.gif" width="1" height="20">`;
    const { html: out, blocked } = await stripTrackers(html, RULES);
    expect(blocked).toBe(2);
    expect(out).not.toContain("e2t/o");
    expect(out).not.toContain("px.gif");
    expect(out).toContain("hero.png");
    expect(out).toContain("cid:logo"); // inline — no request, whatever its size
    expect(out).toContain("sp.gif");
    expect(out).toContain("<p>Hi</p>");
  });

  it("still catches pixel-shaped beacons with no list at all", async () => {
    const html = `<img src="https://email.example.com/e3t/Cto/abc" width="1" height="1" style="display:none!important">`;
    const { blocked } = await stripTrackers(html, compileRules([]));
    expect(blocked).toBe(1);
  });

  it("drops a tracker hiding in srcset even when src is clean", async () => {
    const html = `<img src="https://cdn.example.com/a.png" srcset="https://t.example.com/wf/open?upn=1 2x">`;
    const { html: out, blocked } = await stripTrackers(html, RULES);
    expect(blocked).toBe(1);
    expect(out).not.toContain("<img");
  });

  it("neutralises tracker url()s in inline styles, <style> blocks and background=", async () => {
    const html =
      `<style>.h{background:url(https://t.yesware.com/t/abc.gif) no-repeat}</style>` +
      `<td background="https://r20.rs6.net/on.jsp?x=1" style="background-image:url('https://x.example.com/wf/open?upn=2')">` +
      `<div style="background:url(https://cdn.example.com/bg.png)">x</div></td>`;
    const { html: out, blocked } = await stripTrackers(html, RULES);
    expect(blocked).toBe(3);
    expect(out).not.toContain("yesware");
    expect(out).not.toContain("on.jsp");
    expect(out).not.toContain("wf/open");
    expect(out).toContain("background:none no-repeat");
    expect(out).toContain("bg.png");
  });

  it("is a no-op on clean markup", async () => {
    const html = `<p>plain</p><img src="https://cdn.example.com/a.png" width="300" height="100">`;
    const { html: out, blocked } = await stripTrackers(html, RULES);
    expect(blocked).toBe(0);
    expect(out).toBe(html);
  });
});

function fetchStub(bodies: Record<string, string | number>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = url.includes("trocker") ? "trocker" : "uglyemail";
    const body = bodies[key];
    if (typeof body === "number") return new Response("nope", { status: body });
    return new Response(body ?? "", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("refreshTrackerList", () => {
  beforeAll(applyMigrationsOnce);
  // resetDb leaves system_config alone (it holds the auth secret); clear ours.
  beforeEach(async () => {
    await resetDb();
    await db().delete(systemConfig).where(eq(systemConfig.key, TRACKER_LIST_KEY));
  });

  const NOW = new Date("2026-09-13T00:00:00Z");
  const HOUR = 60 * 60 * 1000;

  it("fetches both sources, stores merged rules, and serves them", async () => {
    expect(await getTrackerRules(db())).toEqual({ substrings: [], regexes: [] });
    const fetch = fetchStub({ trocker: TROCKER_JS, uglyemail: UGLY_TXT });
    await refreshTrackerList(db(), NOW, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    const rules = await getTrackerRules(db());
    expect(isTrackerUrl("https://x.list-manage.com/track/open.php", rules)).toBe(true);
    expect(isTrackerUrl("https://news.example.com/wf/open?upn=1", rules)).toBe(true);
    const stored = JSON.parse((await getConfig(db(), TRACKER_LIST_KEY))!);
    expect(stored.nextRefreshAt).toBe(NOW.getTime() + 24 * HOUR);
  });

  it("does not refetch until the stored copy is due", async () => {
    const fetch = fetchStub({ trocker: TROCKER_JS, uglyemail: UGLY_TXT });
    await refreshTrackerList(db(), NOW, fetch);
    await refreshTrackerList(db(), new Date(NOW.getTime() + 23 * HOUR), fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    await refreshTrackerList(db(), new Date(NOW.getTime() + 25 * HOUR), fetch);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps a source's previous rules when its fetch fails and retries sooner", async () => {
    await refreshTrackerList(db(), NOW, fetchStub({ trocker: TROCKER_JS, uglyemail: UGLY_TXT }));
    const later = new Date(NOW.getTime() + 25 * HOUR);
    await refreshTrackerList(db(), later, fetchStub({ trocker: 503, uglyemail: UGLY_TXT }));
    const rules = await getTrackerRules(db());
    expect(isTrackerUrl("https://x.list-manage.com/track/open.php", rules)).toBe(true); // Trocker rule survived
    const stored = JSON.parse((await getConfig(db(), TRACKER_LIST_KEY))!);
    expect(stored.nextRefreshAt).toBe(later.getTime() + HOUR);
    expect(stored.sources.trocker.fetchedAt).toBe(NOW.getTime());
    expect(stored.sources.uglyemail.fetchedAt).toBe(later.getTime());
  });
});
