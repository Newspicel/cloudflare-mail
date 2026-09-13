// Keeps email text readable whatever the sender assumed about the page.
//
// Mail HTML styles its text for the canvas the sender's client defaults to
// (nearly always white) and usually leaves the page background unset, so on the
// dark theme its `#333` body copy lands on our dark card and vanishes; light
// text meant for a dark canvas the sanitizer stripped does the same on the
// light theme. `adaptTextContrast` walks every element that paints text,
// resolves the background it actually sits on, and shifts the text's lightness
// (hue and saturation kept) just far enough to read. Text on a background the
// email painted itself is only lifted to the WCAG minimum; text on *our*
// canvas is restored to the contrast it had on the page it was designed for,
// so headings stay stronger than footers instead of collapsing to one grey.

export type Rgb = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

// WCAG 2 minimums (body text / large text).
const MIN_CONTRAST = 4.5;
const MIN_CONTRAST_LARGE = 3;
// Background luminance below which white text beats black: the L where
// (1.05)/(L+.05) == (L+.05)/.05.
const LIGHT_TEXT_BELOW = Math.sqrt(1.05 * 0.05) - 0.05;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Alpha-composites `fg` over an opaque `bg`.
export function over(fg: Rgba, bg: Rgb): Rgb {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

// Moves `fg`'s lightness toward whichever extreme contrasts more with `bg` —
// the smallest step that reaches `target`, or the extreme itself if nothing
// gets there. Hue and saturation are preserved.
export function readableColor(fg: Rgb, bg: Rgb, target: number): Rgb {
  const [h, s, l0] = rgbToHsl(fg);
  const toward = luminance(bg) < LIGHT_TEXT_BELOW ? 1 : 0;
  const at = (l: number) => hslToRgb(h, s, l);
  if (contrastRatio(at(toward), bg) < target) return at(toward);
  let lo = l0;
  let hi = toward;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), bg) >= target) hi = mid;
    else lo = mid;
  }
  return at(hi);
}

export function toCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;

let canvas: CanvasRenderingContext2D | null | undefined;

// Parses any CSS color the browser understands into sRGB. Computed values come
// back as `rgb()`/`rgba()` for most mail, but the theme's own `oklch()` colors
// keep their notation, so anything the regex misses is rendered through a 1×1
// canvas and read back. Returns null for a string the browser rejects.
export function parseCssColor(value: string): Rgba | null {
  const m = RGB_RE.exec(value);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  if (canvas === undefined) {
    canvas =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  }
  if (!canvas) return null;
  canvas.clearRect(0, 0, 1, 1);
  // An unparseable string leaves the sentinel in place, so it paints instead.
  canvas.fillStyle = "#010203";
  canvas.fillStyle = value;
  canvas.fillRect(0, 0, 1, 1);
  const px = canvas.getImageData(0, 0, 1, 1).data;
  const [r, g, b, a] = [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0];
  if (r === 1 && g === 2 && b === 3 && a === 255) return null;
  return [r, g, b, a / 255];
}

// The opaque color an element's text sits on. `canvas` marks our own theme
// background showing through (the email painted nothing on the way up); null
// means unknowable — a background image is in play, so the text is left alone.
type Backdrop = { color: Rgb; canvas: boolean } | null;

function sameColor(a: Rgba, b: Rgba): boolean {
  return Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;
}

// Characters of text the element paints itself (children paint their own).
function ownTextLength(el: Element): number {
  let n = 0;
  for (const c of el.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) n += (c.nodeValue ?? "").trim().length;
  }
  return n;
}

function isRendered(el: Element): boolean {
  // Hidden-preheader tricks (display:none, opacity:0, visibility:hidden) must
  // stay hidden — lightening their white-on-white text would reveal them.
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  }
  return el.getClientRects().length > 0;
}

// Rewrites text colors inside `doc` (an email body rendered on `canvasBg`) so
// every run of text meets WCAG contrast against what's behind it. Idempotent
// per document load; call again after re-rendering.
export function adaptTextContrast(doc: Document, canvasBg: Rgba): void {
  const win = doc.defaultView;
  const body = doc.body;
  const root = doc.documentElement;
  if (!win || !body) return;
  const ours: Rgb = [canvasBg[0], canvasBg[1], canvasBg[2]];
  const backdrops = new Map<Element, Backdrop>();

  const backdropOf = (el: Element): Backdrop => {
    const hit = backdrops.get(el);
    if (hit !== undefined) return hit;
    const cs = win.getComputedStyle(el);
    const own = parseCssColor(cs.backgroundColor);
    let result: Backdrop;
    if (!own || cs.backgroundImage !== "none") {
      result = null;
    } else if (own[3] >= 1) {
      const isPage = el === body || el === root;
      result = { color: [own[0], own[1], own[2]], canvas: isPage && sameColor(own, canvasBg) };
    } else {
      const parent = el.parentElement;
      const under = parent ? backdropOf(parent) : { color: ours, canvas: true };
      if (!under) result = null;
      else if (own[3] === 0) result = under;
      else result = { color: over(own, under.color), canvas: false };
    }
    backdrops.set(el, result);
    return result;
  };

  // Read everything first, then write: a child inheriting a bad color is fixed
  // from the same input as its parent, and no style recalc runs mid-walk.
  const fixes: { el: HTMLElement; fg: Rgb; backdrop: Rgb; canvas: boolean; min: number }[] = [];
  // Which page the email was laid out for. Dark text is written for a light
  // page, light text for a dark one; the bulk of the copy decides, so a muted
  // `#999` footer under `#333` body text reads as muted-on-white rather than
  // bright-on-black and is only nudged, not flipped.
  let forLight = 0;
  let forDark = 0;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    const el = node as HTMLElement;
    const chars = ownTextLength(el);
    if (chars === 0 || !isRendered(el)) continue;
    const cs = win.getComputedStyle(el);
    const size = Number.parseFloat(cs.fontSize);
    // Sub-4px text is another hide-the-preheader idiom, never meant to be read.
    if (!(size >= 4)) continue;
    const fgRaw = parseCssColor(cs.color);
    if (!fgRaw || fgRaw[3] === 0) continue;
    const backdrop = backdropOf(el);
    if (!backdrop) continue;
    const fg: Rgb = fgRaw[3] < 1 ? over(fgRaw, backdrop.color) : [fgRaw[0], fgRaw[1], fgRaw[2]];
    if (backdrop.canvas) {
      if (luminance(fg) < LIGHT_TEXT_BELOW) forLight += chars;
      else forDark += chars;
    }
    const bold = (Number.parseInt(cs.fontWeight, 10) || 400) >= 700;
    const min = size >= 24 || (bold && size >= 18.66) ? MIN_CONTRAST_LARGE : MIN_CONTRAST;
    if (contrastRatio(fg, backdrop.color) >= min) continue;
    fixes.push({ el, fg, backdrop: backdrop.color, canvas: backdrop.canvas, min });
  }
  const designedFor: Rgb = forDark > forLight ? [0, 0, 0] : [255, 255, 255];
  for (const f of fixes) {
    const target = f.canvas ? Math.max(f.min, contrastRatio(f.fg, designedFor)) : f.min;
    f.el.style.setProperty("color", toCss(readableColor(f.fg, f.backdrop, target)), "important");
  }
}
