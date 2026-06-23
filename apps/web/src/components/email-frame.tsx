import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";

// Untrusted email HTML is rendered inside a sandboxed iframe rather than inline
// in the app DOM, so a sanitizer bypass can't reach the session. The sandbox
// grants `allow-same-origin` (so the parent can measure content height and
// proxied same-origin images resolve) but NOT `allow-scripts`, so no script in
// the body can execute — making the same-origin grant inert. A meta CSP is a
// second, independent lock on scripts and remote loads.
const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

// Blocks scripts and every remote fetch except same-origin proxied images and
// inline `data:` images; styles are inline-only (no remote stylesheets/fonts).
// `frame-ancestors`/`sandbox` are ignored in a meta CSP — the iframe element's
// `sandbox` attribute handles framing/script policy instead.
const CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
  "font-src 'self' data:; script-src 'none'; base-uri 'none'; form-action 'none'";

// The iframe gets none of the app's stylesheet, so pull the current palette off
// the parent root (Tailwind emits the theme as `--color-*` custom properties;
// `.dark` on <html> swaps them) to keep the body matching light/dark chrome.
function frameColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    dark: document.documentElement.classList.contains("dark"),
    fg: v("--color-card-foreground", "#1f2937"),
    bg: v("--color-card", "#ffffff"),
    link: v("--color-primary", "#2563eb"),
  };
}

type Colors = ReturnType<typeof frameColors>;

function buildDoc(bodyHtml: string, c: Colors): string {
  const scheme = c.dark ? "dark" : "light";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>` +
    `html{color-scheme:${scheme}}html,body{margin:0}` +
    `body{padding:12px 16px;font:13px/1.5 "Inter var",ui-sans-serif,system-ui,-apple-system,` +
    `"Segoe UI",Roboto,sans-serif;color:${c.fg};background:${c.bg};` +
    `overflow-wrap:anywhere;word-break:break-word}` +
    `img,video,table{max-width:100%}img{height:auto}` +
    `a{color:${c.link}}pre{white-space:pre-wrap}table{border-collapse:collapse}` +
    `blockquote{margin:0;padding-left:12px;border-left:2px solid currentColor;opacity:.7}` +
    `</style></head><body>${bodyHtml}</body></html>`
  );
}

// Renders sanitized email HTML in an isolated iframe and auto-sizes it to the
// content. `html` must already be sanitized (see `sanitizeEmailHtml`).
export function EmailFrame({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [colors, setColors] = useState<Colors>(frameColors);
  const [height, setHeight] = useState(0);

  // Re-theme the frame when the app toggles dark mode.
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(frameColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const doc = useMemo(() => buildDoc(html, colors), [html, colors]);

  // `allow-same-origin` + no scripts lets us read the child document to size it;
  // re-observe on every (re)load so late reflow (image loads) keeps it exact.
  const onLoad = useCallback(() => {
    roRef.current?.disconnect();
    const d = ref.current?.contentDocument;
    const root = d?.documentElement;
    if (!root) return;
    const update = () => setHeight(root.scrollHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    roRef.current = ro;
  }, []);

  useEffect(() => () => roRef.current?.disconnect(), []);

  return (
    <iframe
      ref={ref}
      title="Message body"
      srcDoc={doc}
      onLoad={onLoad}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      className={cn("block w-full", className)}
      style={{ height: height ? `${height}px` : undefined }}
    />
  );
}
