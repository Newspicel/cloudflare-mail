// Detect one-time verification codes and magic sign-in links in a message so
// the reader can copy the code / open the link without hunting through the body.
// Purely client-side and heuristic: gated on nearby keywords to keep false
// positives (order numbers, prices, tracking IDs) low. Nothing is stored.

export interface DetectedCode {
  code: string;
}

export interface DetectedLink {
  url: string;
  label: string;
}

export interface Detected {
  codes: DetectedCode[];
  links: DetectedLink[];
}

// Words that signal a nearby token is an auth code, not just any number.
const CODE_KEYWORDS =
  /(one[-\s]?time|verification|verify|security|confirm(?:ation)?|authenticat|access|passcode|pass\s?code|\botp\b|\bpin\b|\bcode\b|2fa|two[-\s]?factor|log[-\s]?in|sign[-\s]?in)/i;

// A plausible code: 4–8 digits (optionally split 3-3 / 4-4), or a 5–8 char
// alphanumeric token that mixes at least one letter and one digit.
const TOKEN =
  /\b(\d{3}[-\s]\d{3}|\d{4}[-\s]\d{4}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})\b/g;

// Keywords that mark a link as a sign-in / magic / confirmation link.
const LINK_KEYWORDS =
  /(magic|login|log[-\s]?in|sign[-\s]?in|verify|verification|confirm|activate|activation|one[-\s]?click|reset|\bauth\b|\btoken\b)/i;

// A long opaque path segment or token-bearing query param — the fingerprint of
// a single-use link rather than a plain marketing URL.
const LINK_TOKEN =
  /(?:[/=][A-Za-z0-9._~-]{20,})|[?&](?:token|code|key|otp|t|k|auth|magic|nonce|session|confirmation[_-]?token)=[A-Za-z0-9._~-]{8,}/i;

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

const MAX_CODES = 3;

function normalize(code: string): string {
  // Collapse "123 456" / "123-456" to a copy-friendly "123456".
  return code.replace(/[-\s]/g, "");
}

// A window of chars either side of a token likely to hold the keyword.
const BEFORE = 48;
const AFTER = 24;

function scanForCodes(haystack: string, out: Map<string, DetectedCode>, requireKeyword: boolean) {
  for (const m of haystack.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (requireKeyword) {
      const ctx = haystack.slice(Math.max(0, idx - BEFORE), idx + m[0].length + AFTER);
      if (!CODE_KEYWORDS.test(ctx)) continue;
    }
    const code = normalize(m[0]);
    if (!out.has(code)) out.set(code, { code });
    if (out.size >= MAX_CODES) return;
  }
}

function detectCodes(subject: string, body: string): DetectedCode[] {
  const out = new Map<string, DetectedCode>();
  // A code in the subject is high-signal on its own if the subject reads like a
  // verification message; otherwise fall back to keyword-gated body scanning.
  if (CODE_KEYWORDS.test(subject)) scanForCodes(subject, out, false);
  if (out.size < MAX_CODES) scanForCodes(body, out, true);
  return [...out.values()];
}

function isMagicLink(url: string, text: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return (LINK_KEYWORDS.test(url) || LINK_KEYWORDS.test(text)) && LINK_TOKEN.test(url);
}

function detectMagicLinks(links: { url: string; text: string }[]): DetectedLink[] {
  const seen = new Set<string>();
  const out: DetectedLink[] = [];
  for (const { url, text } of links) {
    if (seen.has(url) || !isMagicLink(url, text)) continue;
    seen.add(url);
    const label = text && text.length <= 40 ? text : "Sign in";
    out.push({ url, label });
    if (out.length >= 2) break;
  }
  return out;
}

// Pull visible text and anchors out of email HTML without touching the live DOM.
function fromHtml(html: string): { text: string; links: { url: string; text: string }[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const links = [...doc.querySelectorAll("a[href]")].map((a) => ({
    url: a.getAttribute("href") ?? "",
    text: a.textContent?.trim() ?? "",
  }));
  return { text: doc.body?.textContent ?? "", links };
}

export function detectCodesAndLinks(input: {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}): Detected {
  let body = input.text ?? "";
  let links: { url: string; text: string }[] = [];
  if (input.html) {
    const parsed = fromHtml(input.html);
    if (!body) body = parsed.text;
    links = parsed.links;
  }
  if (links.length === 0 && body) {
    for (const m of body.matchAll(URL_RE)) links.push({ url: m[0], text: "" });
  }
  return {
    codes: detectCodes(input.subject ?? "", body),
    links: detectMagicLinks(links),
  };
}
