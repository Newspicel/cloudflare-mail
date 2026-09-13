import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  luminance,
  over,
  parseCssColor,
  type Rgb,
  readableColor,
} from "./contrast.ts";

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
// The dark theme's card (oklch(0.2 0 0)) and the light theme's.
const DARK_CARD: Rgb = [48, 48, 48];
const LIGHT_CARD: Rgb = [255, 255, 255];

describe("contrastRatio", () => {
  it("spans 1:1 to 21:1", () => {
    expect(contrastRatio(WHITE, WHITE)).toBe(1);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
  });
});

describe("readableColor", () => {
  it("lightens dark text on a dark canvas until it meets the target", () => {
    const fixed = readableColor([51, 51, 51], DARK_CARD, 4.5);
    expect(contrastRatio(fixed, DARK_CARD)).toBeGreaterThanOrEqual(4.5);
    expect(luminance(fixed)).toBeGreaterThan(luminance([51, 51, 51]));
  });

  it("darkens light text on a light canvas", () => {
    const fixed = readableColor([238, 238, 238], LIGHT_CARD, 4.5);
    expect(contrastRatio(fixed, LIGHT_CARD)).toBeGreaterThanOrEqual(4.5);
    expect(luminance(fixed)).toBeLessThan(luminance([238, 238, 238]));
  });

  it("takes the smallest step that reaches the target", () => {
    // #888 on white is 3.5:1; a nudge to ~#767676 reaches 4.5:1 — no flip to black.
    const fixed = readableColor([136, 136, 136], LIGHT_CARD, 4.5);
    expect(contrastRatio(fixed, LIGHT_CARD)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fixed, LIGHT_CARD)).toBeLessThan(5);
  });

  it("keeps hue and saturation — a red stays red", () => {
    const fixed = readableColor([204, 0, 0], DARK_CARD, 6);
    expect(contrastRatio(fixed, DARK_CARD)).toBeGreaterThanOrEqual(6);
    const [r, g, b] = fixed;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(g).toBe(b);
  });

  it("falls back to the extreme when the target is out of reach", () => {
    // Nothing gets 21:1 on a #303030 card; white is the best there is.
    expect(readableColor(BLACK, DARK_CARD, 21)).toEqual(WHITE);
  });

  it("restores designed contrast: #333 and #666 stay distinct on a dark card", () => {
    const primary = readableColor([51, 51, 51], DARK_CARD, contrastRatio([51, 51, 51], WHITE));
    const muted = readableColor([102, 102, 102], DARK_CARD, contrastRatio([102, 102, 102], WHITE));
    expect(luminance(primary)).toBeGreaterThan(luminance(muted));
    expect(contrastRatio(muted, DARK_CARD)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("over", () => {
  it("composites translucent text onto its backdrop", () => {
    expect(over([0, 0, 0, 0.5], WHITE)).toEqual([128, 128, 128]);
    expect(over([0, 0, 0, 0], WHITE)).toEqual(WHITE);
  });
});

describe("parseCssColor", () => {
  it("reads the rgb()/rgba() forms computed styles produce", () => {
    expect(parseCssColor("rgb(51, 51, 51)")).toEqual([51, 51, 51, 1]);
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual([0, 0, 0, 0]);
    expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 0.5]);
    expect(parseCssColor("rgb(10 20 30 / 50%)")).toEqual([10, 20, 30, 0.5]);
  });

  it("returns null without a canvas to fall back on", () => {
    expect(parseCssColor("oklch(0.2 0 0)")).toBeNull();
  });
});
