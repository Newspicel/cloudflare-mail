// Server-side defense-in-depth for stored email HTML, applied at serve time in
// the message-body endpoint. The client sanitizer (DOMPurify-side allowlist)
// remains the primary defense; this strips the highest-risk vectors so a
// client-side bypass alone can't execute script. Stored mail is never modified.
// Best-effort: a rewrite failure falls back to the un-stripped body (the client
// sanitizer still runs), never a hard error.

const BLOCKED_ELEMENTS = ["script", "iframe", "object", "embed", "base"];
const URL_ATTRS = ["href", "src"] as const;

// `javascript:` after stripping the control/whitespace chars HTML parsers
// ignore inside a scheme (`java\nscript:`, `\tjavascript:`).
function isScriptUrl(value: string): boolean {
  let cleaned = "";
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) cleaned += ch;
  }
  return cleaned.toLowerCase().startsWith("javascript:");
}

export async function sanitizeEmailHtml(html: string): Promise<string> {
  try {
    let rewriter = new HTMLRewriter();
    for (const tag of BLOCKED_ELEMENTS) {
      rewriter = rewriter.on(tag, {
        element(el) {
          el.remove();
        },
      });
    }
    const res = rewriter
      .on("*", {
        element(el) {
          const eventAttrs: string[] = [];
          for (const [name] of el.attributes) {
            if (name && /^on/i.test(name)) eventAttrs.push(name);
          }
          for (const name of eventAttrs) el.removeAttribute(name);
          for (const attr of URL_ATTRS) {
            const value = el.getAttribute(attr);
            if (value && isScriptUrl(value)) el.removeAttribute(attr);
          }
        },
      })
      .transform(new Response(html));
    return await res.text();
  } catch (err) {
    console.error("server-side html sanitize failed", err);
    return html;
  }
}
