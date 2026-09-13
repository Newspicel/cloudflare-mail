import { systemConfig } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, setConfig } from "../src/config.ts";
import {
  compileRules,
  getTrackerRules,
  isTrackerUrl,
  looksLikePixel,
  parseEasyPrivacy,
  parseMailTrackerBlocker,
  refreshTrackerList,
  stripTrackers,
  TRACKER_LIST_KEY,
} from "../src/mail/trackers.ts";
import { applyMigrationsOnce, db, resetDb } from "./support/app.ts";

// Excerpts in the exact shape of the upstream files, padded past the
// per-source sanity threshold.
const PAD = Array.from({ length: 20 }, (_, i) => i);
const MTB_OBJC = `
+ (NSDictionary*)getTrackerDict {
    return @{
        @"1&1": @[
            @"simg.1und1.de",
            @"oc.ionos.com/\\\\?utm_rid=",
        ],
        @"ActiveCampaign": @[
            @"/lt.php\\\\?", // trailing comment
            @"/Prod/link-tracker\\\\?nl="
        ],
        @"HubSpot": @[
            @"/e2t/o/",
//            @"/e2t/commented-out/",
            @"/e3t/[bc]to/"
        ],
        @"Mailchimp": @[@"list-manage.com/track/open.php"],
        @"Campaign Monitor": @[@"createsend[0-9]+.com"],
${PAD.map((i) => `        @"Vendor${i}": @[@"v${i}.tracker.example/o/"],`).join("\n")}
    };
}
`;
const EASYPRIVACY_TXT = [
  "! easyprivacy_general_emailtrackers.txt",
  "! Email tracking pixels",
  "/wf/open?upn=$image",
  ".email.*/tr/op/$image",
  ".pstmrk.it/open^",
  "||awstrack.me/I0/$image",
  "@@||allowed.example/pixel.gif",
  "example.com##.ad",
  ...PAD.map((i) => `.v${i}.example/open/$image`),
].join("\n");

const RULES = compileRules([
  parseMailTrackerBlocker(MTB_OBJC)!,
  parseEasyPrivacy(EASYPRIVACY_TXT)!,
]);

describe("upstream list parsers", () => {
  it("reads MailTrackerBlocker's ObjC dictionary: values only, unescaped, comments dropped", () => {
    const parsed = parseMailTrackerBlocker(MTB_OBJC)!;
    expect(parsed.regexes).toHaveLength(8 + PAD.length);
    expect(parsed.regexes).toContain("oc.ionos.com/\\?utm_rid=");
    expect(parsed.regexes).toContain("/lt.php\\?");
    expect(parsed.regexes).toContain("/e3t/[bc]to/");
    expect(parsed.regexes).not.toContain("/e2t/commented-out/");
    expect(parsed.regexes).not.toContain("HubSpot"); // a key, not a pattern
    expect(parseMailTrackerBlocker("nothing here")).toBeNull();
    expect(parseMailTrackerBlocker('getTrackerDict {\n @"X": @[@"only-one"] }')).toBeNull(); // below threshold
  });

  it("reads EasyPrivacy's Adblock rules, skipping comments, exceptions and element hiding", () => {
    const parsed = parseEasyPrivacy(EASYPRIVACY_TXT)!;
    expect(parsed.regexes).toHaveLength(4 + PAD.length);
    expect(parseEasyPrivacy("! only comments")).toBeNull();
  });

  it("compiles rules and drops broken or oversized ones", () => {
    const rules = compileRules([
      {
        substrings: ["A.Example/T", "x".repeat(400)],
        regexes: ["(unclosed", "\\/ok\\/", "y".repeat(400)],
      },
    ]);
    expect(rules.substrings).toEqual(["a.example/t"]);
    expect(rules.regexes).toHaveLength(1);
  });
});

describe("isTrackerUrl", () => {
  it("matches MailTrackerBlocker regex fragments against the full URL, any case", () => {
    // The exact beacon shape from the report, on a customer CNAME.
    expect(
      isTrackerUrl("https://email.linuxfoundation.org/e3t/Cto/RI+113/cZw--04/VVwK6", RULES),
    ).toBe(true);
    expect(isTrackerUrl("https://x.list-manage.com/track/open.php?u=1", RULES)).toBe(true);
    expect(isTrackerUrl("https://oc.ionos.com/?utm_rid=abc", RULES)).toBe(true);
    expect(isTrackerUrl("https://x.example.com/lt.php?s=1&l=open", RULES)).toBe(true);
  });

  it("matches EasyPrivacy rules with wildcards, separators and domain anchors", () => {
    expect(isTrackerUrl("https://news.example.com/wf/open?upn=abc", RULES)).toBe(true);
    expect(isTrackerUrl("https://x.email.example.com/tr/op/abc", RULES)).toBe(true); // `*` wildcard
    expect(isTrackerUrl("https://x.pstmrk.it/open/abc", RULES)).toBe(true); // `^` separator
    expect(isTrackerUrl("https://x.pstmrk.it/opened/abc", RULES)).toBe(false);
    expect(isTrackerUrl("https://sub.awstrack.me/I0/x", RULES)).toBe(true); // `||` anchor
    expect(isTrackerUrl("https://evil.example/awstrack.me/I0/x", RULES)).toBe(false);
  });

  it("leaves ordinary content images and non-http sources alone", () => {
    expect(isTrackerUrl("https://cdn.example.com/hero.png", RULES)).toBe(false);
    // Upstream's broad Campaign Monitor rule would hide their image CDN; allowlisted.
    expect(isTrackerUrl("https://x.createsend1.com/t/r-o-abc/o.gif", RULES)).toBe(true);
    expect(isTrackerUrl("https://i1.createsend1.com/ei/r/AB/CD/hero.png", RULES)).toBe(false);
    expect(isTrackerUrl("https://images.example.com/track-and-field.jpg", RULES)).toBe(false);
    expect(isTrackerUrl("https://x.example.com/e2t/commented-out/1", RULES)).toBe(false);
    expect(isTrackerUrl("cid:logo@example", RULES)).toBe(false);
    expect(isTrackerUrl("data:image/gif;base64,R0lGOD", RULES)).toBe(false);
    expect(isTrackerUrl("not a url", RULES)).toBe(false);
    expect(
      isTrackerUrl(`https://x.list-manage.com/track/open.php?${"a".repeat(3000)}`, RULES),
    ).toBe(false); // over the test cap
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
      `<img src="https://email.example.com/e3t/Cto/abc" alt="">` +
      `<img src="https://cdn.example.com/px.gif?u=1" width="1" height="1">` +
      `<img src="https://cdn.example.com/hero.png" width="600" height="200">` +
      `<img src="cid:logo" width="1" height="1">` +
      `<img src="https://cdn.example.com/sp.gif" width="1" height="20">`;
    const { html: out, blocked } = await stripTrackers(html, RULES);
    expect(blocked).toBe(2);
    expect(out).not.toContain("e3t/Cto");
    expect(out).not.toContain("px.gif");
    expect(out).toContain("hero.png");
    expect(out).toContain("cid:logo"); // inline — no request, whatever its size
    expect(out).toContain("sp.gif");
    expect(out).toContain("<p>Hi</p>");
  });

  it("still catches pixel-shaped beacons with no list at all", async () => {
    const html = `<img src="https://email.example.com/unknown-vendor/abc" width="1" height="1" style="display:none!important">`;
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
      `<style>.h{background:url(https://x.list-manage.com/track/open.php?u=1) no-repeat}</style>` +
      `<td background="https://sub.awstrack.me/I0/x" style="background-image:url('https://x.example.com/wf/open?upn=2')">` +
      `<div style="background:url(https://cdn.example.com/bg.png)">x</div></td>`;
    const { html: out, blocked } = await stripTrackers(html, RULES);
    expect(blocked).toBe(3);
    expect(out).not.toContain("list-manage");
    expect(out).not.toContain("awstrack");
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
    const key = url.includes("MailTrackerBlocker") ? "mtb" : "easyprivacy";
    const body = bodies[key];
    if (typeof body === "number") return new Response("nope", { status: body });
    return new Response(body ?? "", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("refreshTrackerList / getTrackerRules", () => {
  beforeAll(applyMigrationsOnce);
  // resetDb leaves system_config alone (it holds the auth secret); clear ours.
  beforeEach(async () => {
    await resetDb();
    await db().delete(systemConfig).where(eq(systemConfig.key, TRACKER_LIST_KEY));
  });

  const NOW = new Date("2026-09-13T00:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const BOTH = { mtb: MTB_OBJC, easyprivacy: EASYPRIVACY_TXT };

  it("serves the local findings before any list has been fetched", async () => {
    const rules = await getTrackerRules(db());
    expect(
      isTrackerUrl("https://eventtracking.hubapi.com/events/duration/v1/track/td/VVw", rules),
    ).toBe(true);
    expect(isTrackerUrl("https://x.example.com/__ptq.gif?k=1", rules)).toBe(true);
    expect(isTrackerUrl("https://news.example.com/wf/open?upn=1", rules)).toBe(false);
  });

  it("fetches both sources, stores merged rules, and serves them with the local ones", async () => {
    const fetch = fetchStub(BOTH);
    await refreshTrackerList(db(), NOW, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    const rules = await getTrackerRules(db());
    expect(isTrackerUrl("https://x.list-manage.com/track/open.php", rules)).toBe(true);
    expect(isTrackerUrl("https://news.example.com/wf/open?upn=1", rules)).toBe(true);
    expect(isTrackerUrl("https://eventtracking.hubapi.com/x", rules)).toBe(true);
    const stored = JSON.parse((await getConfig(db(), TRACKER_LIST_KEY))!);
    expect(Object.keys(stored.sources).toSorted()).toEqual(["easyprivacy", "mailtrackerblocker"]);
    expect(stored.nextRefreshAt).toBe(NOW.getTime() + 24 * HOUR);
  });

  it("does not refetch until the stored copy is due", async () => {
    const fetch = fetchStub(BOTH);
    await refreshTrackerList(db(), NOW, fetch);
    await refreshTrackerList(db(), new Date(NOW.getTime() + 23 * HOUR), fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    await refreshTrackerList(db(), new Date(NOW.getTime() + 25 * HOUR), fetch);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps a source's previous rules when its fetch fails and retries sooner", async () => {
    await refreshTrackerList(db(), NOW, fetchStub(BOTH));
    const later = new Date(NOW.getTime() + 25 * HOUR);
    await refreshTrackerList(db(), later, fetchStub({ mtb: 503, easyprivacy: EASYPRIVACY_TXT }));
    const rules = await getTrackerRules(db());
    expect(isTrackerUrl("https://x.list-manage.com/track/open.php", rules)).toBe(true); // MTB rule survived
    const stored = JSON.parse((await getConfig(db(), TRACKER_LIST_KEY))!);
    expect(stored.nextRefreshAt).toBe(later.getTime() + HOUR);
    expect(stored.sources.mailtrackerblocker.fetchedAt).toBe(NOW.getTime());
    expect(stored.sources.easyprivacy.fetchedAt).toBe(later.getTime());
  });

  it("treats an unparseable upstream (format drift) as a failed fetch", async () => {
    await refreshTrackerList(db(), NOW, fetchStub(BOTH));
    const later = new Date(NOW.getTime() + 25 * HOUR);
    await refreshTrackerList(
      db(),
      later,
      fetchStub({ mtb: "// file moved", easyprivacy: EASYPRIVACY_TXT }),
    );
    const stored = JSON.parse((await getConfig(db(), TRACKER_LIST_KEY))!);
    expect(stored.sources.mailtrackerblocker.fetchedAt).toBe(NOW.getTime());
    expect(stored.nextRefreshAt).toBe(later.getTime() + HOUR);
  });

  it("drops sources that are no longer configured", async () => {
    await setConfig(
      db(),
      TRACKER_LIST_KEY,
      JSON.stringify({
        version: 1,
        nextRefreshAt: 0,
        sources: { trocker: { substrings: ["old.example/t"], regexes: [], fetchedAt: 1 } },
      }),
    );
    await refreshTrackerList(db(), NOW, fetchStub(BOTH));
    const stored = JSON.parse((await getConfig(db(), TRACKER_LIST_KEY))!);
    expect(stored.sources.trocker).toBeUndefined();
    expect(isTrackerUrl("https://old.example/t/1", await getTrackerRules(db()))).toBe(false);
  });
});
