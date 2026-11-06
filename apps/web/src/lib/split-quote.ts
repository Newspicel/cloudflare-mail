// Separates a reply's own text from the conversation history it quotes, so the
// thread view can fold the history away (every earlier message is already its
// own card). Forwards are left whole: the forwarded content *is* the message.
// Returns `quote: null` when there is nothing to fold, or when folding would
// leave an empty message.

export interface SplitBody {
  main: string;
  quote: string | null;
}

// Reply wrappers written by common clients, ours (`mail/quote.ts`) first.
const QUOTE_SELECTOR = [
  ".cfmail-quote",
  ".gmail_quote",
  ".protonmail_quote",
  ".yahoo_quoted",
  "blockquote[type='cite']",
  "div[id='appendonsend']",
  "div[id='divRplyFwdMsg']",
].join(",");

// Outlook marks only where the history starts; everything after it is quoted.
const CUT_REST = new Set(["appendonsend", "divRplyFwdMsg"]);

const FORWARD_RE = /^\s*-{2,}\s*Forwarded message/i;

function hasContent(el: Element): boolean {
  return (el.textContent ?? "").trim() !== "" || el.querySelector("img") !== null;
}

export function splitQuotedHtml(html: string): SplitBody {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;
  const matches = [...body.querySelectorAll(QUOTE_SELECTOR)].filter(
    (el) => !el.parentElement?.closest(QUOTE_SELECTOR) && !FORWARD_RE.test(el.textContent ?? ""),
  );
  if (matches.length === 0) return { main: html, quote: null };

  const removed = doc.createElement("div");
  for (const el of matches) {
    if (!el.isConnected) continue;
    const cut: Element[] = [el];
    if (CUT_REST.has(el.id)) {
      // Outlook draws an <hr> just before the header block.
      const prev = el.previousElementSibling;
      if (prev?.tagName === "HR") cut.unshift(prev);
      for (let next = el.nextElementSibling; next; next = next.nextElementSibling) cut.push(next);
    } else {
      // Thunderbird puts the "On … wrote:" line beside the blockquote.
      const prev = el.previousElementSibling;
      if (prev?.classList.contains("moz-cite-prefix")) cut.unshift(prev);
    }
    for (const node of cut) removed.append(node);
  }
  if (!hasContent(body) || !hasContent(removed)) return { main: html, quote: null };
  return { main: body.innerHTML, quote: removed.innerHTML };
}

const ATTRIBUTION_RE = /(wrote|schrieb|a écrit|escribió|ha scritto|schreef)\s*:\s*$/i;
const ORIGINAL_RE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;

export function splitQuotedText(text: string): SplitBody {
  const lines = text.split(/\r?\n/);
  let cut = lines.findIndex((l) => ORIGINAL_RE.test(l));
  if (cut === -1) {
    // A trailing run of `>` lines (blank lines allowed), plus the attribution
    // line that introduces it.
    let i = lines.length - 1;
    while (i >= 0 && lines[i]!.trim() === "") i--;
    const end = i;
    while (i >= 0 && (lines[i]!.startsWith(">") || lines[i]!.trim() === "")) i--;
    if (i === end) return { main: text, quote: null };
    cut = i + 1;
    let j = i;
    while (j >= 0 && lines[j]!.trim() === "") j--;
    if (j >= 0 && ATTRIBUTION_RE.test(lines[j]!)) {
      cut = j;
      // Clients wrap a long "On <date>, <name> wrote:" over two lines.
      if (
        j >= 1 &&
        /^(On|Am|Le|El|Il|Op)\s/.test(lines[j - 1]!) &&
        !/^(On|Am|Le|El|Il|Op)\s/.test(lines[j]!)
      )
        cut = j - 1;
    }
  }
  const main = lines.slice(0, cut).join("\n").trimEnd();
  const quote = lines.slice(cut).join("\n").trim();
  if (!main || !quote) return { main: text, quote: null };
  return { main, quote };
}

// The stored snippet is the body flattened to one line, so the quote can only
// be found by its intro: "On … wrote:" (and its translations) or Outlook's
// header block.
const SNIPPET_QUOTE_RE = new RegExp(
  [
    String.raw`\b(On|Am|Le|El|Il|Op)\s.{1,200}?\b(wrote|schrieb|a écrit|escribió|ha scritto|schreef)\s*:`,
    String.raw`-{2,}\s*Original Message\s*-{2,}`,
    String.raw`\bFrom:\s.{1,200}?\bSent:\s`,
  ].join("|"),
  "i",
);

export function stripQuotedSnippet(snippet: string): string {
  const at = snippet.search(SNIPPET_QUOTE_RE);
  const main = at === -1 ? snippet : snippet.slice(0, at).trimEnd();
  return main || snippet;
}
