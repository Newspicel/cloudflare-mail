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

// Sanitizes an email HTML body for rendering. The worker has already rewritten
// every remote-content vector (`<img>`, `background`, CSS `url(…)`) to the
// signed same-origin proxy, so the only job left here is to strip anything that
// could *re*-introduce a remote fetch — tracking pixels leak the reader's IP.
// We allowlist HTML (no SVG/MathML, which can pull remote refs via `<image>`/
// `<use>`) and explicitly forbid every tag/attr that loads an external URL on
// its own (stylesheets, media, frames, form submission). Scripts and event
// handlers are dropped by DOMPurify's defaults.
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
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
  });
}
