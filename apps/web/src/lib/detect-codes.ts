// Detect one-time verification codes and magic sign-in links in a message so
// the reader can copy the code / open the link without hunting through the body.
// Purely client-side and heuristic. Nothing is stored.
//
// Two rules keep false positives down:
//   1. Numeric codes are only surfaced when the message actually reads like a
//      verification email (a code keyword appears somewhere).
//   2. The strongest signal is an isolated token — a code alone on its own line
//      / in its own block — which is how virtually every provider presents it.

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

// Words that signal the message is a verification / auth email.
const CODE_KEYWORDS =
  /(one[-\s]?time|verification|verify|verifizier|security|confirm|bestätig|codigo|código|authenticat|passcode|pass\s?code|\botp\b|\bpin\b|\bcode\b|2fa|two[-\s]?factor|log[-\s]?in|sign[-\s]?in|anmeld)/i;

// A plausible code: 4–8 digits (optionally split 3-3 / 4-4), or a 5–8 char
// alphanumeric token mixing at least one letter and one digit.
const NUM = String.raw`\d{3}[-\s]\d{3}|\d{4}[-\s]\d{4}|\d{4,8}`;
const ALNUM = String.raw`(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8}`;
const TOKEN = new RegExp(String.raw`\b(${NUM}|${ALNUM})\b`, "g");
// A token that is the whole line, bar surrounding spaces/punctuation.
const ISOLATED = new RegExp(String.raw`^[^\p{L}\p{N}]*(${NUM}|${ALNUM})[^\p{L}\p{N}]*$`, "u");

const MAX_CODES = 3;
const BEFORE = 60;
const AFTER = 40;

function normalize(code: string): string {
  return code.replace(/[-\s]/g, "");
}

// Standalone 4-digit years read as codes far too easily; reject them unless the
// token is isolated on its own line (then it's almost certainly the real code).
function isYearLike(code: string): boolean {
  return /^(19|20)\d{2}$/.test(code);
}

function detectCodes(subject: string, text: string): DetectedCode[] {
  if (!CODE_KEYWORDS.test(subject) && !CODE_KEYWORDS.test(text)) return [];

  const out = new Map<string, DetectedCode>();
  const add = (raw: string, isolated: boolean) => {
    const code = normalize(raw);
    if (!isolated && isYearLike(code)) return;
    if (!out.has(code)) out.set(code, { code });
  };

  // A code alone in the subject line ("204446 is your code").
  if (CODE_KEYWORDS.test(subject)) {
    for (const m of subject.matchAll(TOKEN)) add(m[0], false);
  }

  // Strongest signal: a token on its own line / block.
  for (const line of text.split("\n")) {
    if (out.size >= MAX_CODES) break;
    const m = line.trim().match(ISOLATED);
    if (m?.[1]) add(m[1], true);
  }

  // Fallback: a token with a code keyword in its immediate vicinity.
  for (const m of text.matchAll(TOKEN)) {
    if (out.size >= MAX_CODES) break;
    const i = m.index ?? 0;
    const ctx = text.slice(Math.max(0, i - BEFORE), i + m[0].length + AFTER);
    if (CODE_KEYWORDS.test(ctx)) add(m[0], false);
  }

  return [...out.values()].slice(0, MAX_CODES);
}

// Magic-link matching is deliberately strict: a sign-in keyword plus an
// auth-looking token (query param or path segment), and never an
// unsubscribe/support/preferences link. Better to miss than to mislabel a
// tracking URL as a login link.
const LINK_TEXT_KW =
  /(sign[-\s]?in|log[-\s]?in|magic|verify|verifizier|confirm|bestätig|activate|aktivier|reset|set (?:up|your) password|anmeld|einlogg)/i;
const LINK_URL_KW =
  /(magic|\/login|signin|sign-in|verify|confirm|activate|passwordless|one-?click|\/auth\/|\/session\/|\/invite\/)/i;
const AUTH_PARAM =
  /[?&](?:token|otp|magic|code|auth|confirmation[_-]?token|verification[_-]?token|login[_-]?token|access[_-]?token|k|key)=[A-Za-z0-9._~+/-]{12,}/i;
const AUTH_PATH =
  /\/(?:magic|login|signin|sign-in|verify|confirm|activate|auth|session|token|passwordless|invite)\/[A-Za-z0-9._~+/-]{16,}/i;
const EXCLUDE_LINK =
  /(unsubscribe|abmeld|opt[-_]?out|preferences|einstellungen|privacy|datenschutz|terms|impressum|\bsupport\b|\bhelp\b|\bhilfe\b|contact|kontakt|list-manage|mailto:)/i;

function isMagicLink(url: string, text: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  if (EXCLUDE_LINK.test(url) || EXCLUDE_LINK.test(text)) return false;
  const keyword = LINK_TEXT_KW.test(text) || LINK_URL_KW.test(url);
  return keyword && (AUTH_PARAM.test(url) || AUTH_PATH.test(url));
}

function detectMagicLinks(links: { url: string; text: string }[]): DetectedLink[] {
  const seen = new Set<string>();
  const out: DetectedLink[] = [];
  for (const { url, text } of links) {
    if (seen.has(url) || !isMagicLink(url, text)) continue;
    seen.add(url);
    out.push({ url, label: text && text.length <= 40 ? text : "Sign in" });
    if (out.length >= 2) break;
  }
  return out;
}

const BLOCK = new Set([
  "P",
  "DIV",
  "BR",
  "TR",
  "TD",
  "TH",
  "LI",
  "UL",
  "OL",
  "TABLE",
  "SECTION",
  "HEADER",
  "FOOTER",
  "ARTICLE",
  "BLOCKQUOTE",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

// Extract visible text + anchors from email HTML. Entities are decoded (so
// "&#128153;" becomes 💙, never the number 128153) and block boundaries become
// newlines (so a code in its own <p> stays isolated instead of gluing to
// neighbouring words).
function fromHtml(html: string): { text: string; links: { url: string; text: string }[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const links = [...doc.querySelectorAll("a[href]")].map((a) => ({
    url: a.getAttribute("href") ?? "",
    text: a.textContent?.trim() ?? "",
  }));
  let text = "";
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        text += child.nodeValue ?? "";
      } else if (child.nodeType === 1) {
        const block = BLOCK.has((child as Element).tagName);
        if (block) text += "\n";
        walk(child);
        if (block) text += "\n";
      }
    }
  };
  walk(doc.body ?? doc.documentElement);
  return { text, links };
}

// Decode entities in a plain-text part (some senders leave "&#128153;" in it).
function decodeEntities(s: string): string {
  return new DOMParser().parseFromString(s, "text/html").body?.textContent ?? s;
}

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function detectCodesAndLinks(input: {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}): Detected {
  let body: string;
  let links: { url: string; text: string }[] = [];
  if (input.html) {
    const parsed = fromHtml(input.html);
    body = parsed.text;
    links = parsed.links;
  } else {
    body = decodeEntities(input.text ?? "");
    for (const m of body.matchAll(URL_RE)) links.push({ url: m[0], text: "" });
  }
  return {
    codes: detectCodes(input.subject ?? "", body),
    links: detectMagicLinks(links),
  };
}
