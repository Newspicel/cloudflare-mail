import DOMPurify from "dompurify";

// Every link in rendered mail opens in a new tab with the opener severed. The
// body renders inside a sandboxed, scriptless iframe, so a link must target
// `_blank` to spawn a tab instead of navigating the frame itself; `noopener`/
// `noreferrer` also kills reverse-tabnabbing. Registered once on the shared
// instance, so it covers the body, the quoted-message preview, and the
// markdown preview alike.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Bare URLs/emails that an HTML body left as plain text (no `<a>`) — mirrors
// linkify.tsx so HTML and plain-text bodies turn the same tokens into anchors.
const URL_TOKEN = /(https?:\/\/[^\s<]+)|(\bwww\.[^\s<]+)|([^\s<@]+@[^\s<@]+\.[^\s<@]+)/gi;
const TRAILING = /[.,;:!?)\]}>'"]+$/;
// Don't rewrite text that's already a link or lives in non-prose elements.
const SKIP_LINKIFY = new Set(["A", "STYLE", "SCRIPT", "TEXTAREA", "NOSCRIPT", "OPTION"]);

// Walk the sanitized tree and turn bare URLs/emails in text nodes into real
// anchors. Runs after sanitization on a DOM we built, and only emits anchors
// with http(s)/mailto hrefs, so it can't reintroduce an injection vector.
function linkifyFragment(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.nodeValue || !/[@.]/.test(text.nodeValue)) continue;
    let skip = false;
    for (let p = text.parentElement; p; p = p.parentElement) {
      if (SKIP_LINKIFY.has(p.tagName)) {
        skip = true;
        break;
      }
    }
    if (!skip) targets.push(text);
  }
  for (const text of targets) {
    const value = text.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    let last = 0;
    let matched = false;
    for (const m of value.matchAll(URL_TOKEN)) {
      matched = true;
      const raw = m[0];
      const start = m.index;
      if (start > last) frag.append(value.slice(last, start));
      const trail = TRAILING.exec(raw)?.[0] ?? "";
      const link = trail ? raw.slice(0, -trail.length) : raw;
      const href = m[3] ? `mailto:${link}` : m[2] ? `https://${link}` : link;
      const a = document.createElement("a");
      a.setAttribute("href", href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.textContent = link;
      frag.append(a);
      if (trail) frag.append(trail);
      last = start + raw.length;
    }
    if (!matched) continue;
    if (last < value.length) frag.append(value.slice(last));
    text.replaceWith(frag);
  }
}

// Sanitizes an email HTML body for rendering. The worker has already rewritten
// every remote-content vector (`<img>`, `background`, CSS `url(…)`) to the
// signed same-origin proxy, so the only job left here is to strip anything that
// could *re*-introduce a remote fetch — tracking pixels leak the reader's IP.
// We allowlist HTML (no SVG/MathML, which can pull remote refs via `<image>`/
// `<use>`) and explicitly forbid every tag/attr that loads an external URL on
// its own (stylesheets, media, frames, form submission). Scripts and event
// handlers are dropped by DOMPurify's defaults.
export function sanitizeEmailHtml(html: string): string {
  const frag = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: ["background"],
    FORBID_TAGS: [
      "link",
      "meta",
      "base",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "portal",
      "video",
      "audio",
      "source",
      "track",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
    ],
    FORBID_ATTR: ["ping", "formaction", "srcdoc"],
    RETURN_DOM_FRAGMENT: true,
  });
  linkifyFragment(frag);
  const holder = document.createElement("div");
  holder.append(frag);
  return holder.innerHTML;
}
