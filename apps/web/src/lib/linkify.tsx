import type { ReactNode } from "react";

// Bare URLs and email addresses in plain-text bodies arrive as text, so turn
// them into real anchors (HTML bodies already get theirs from the sanitizer).
// New tab + severed opener mirrors sanitize-email's anchor policy.
const TOKEN = /(https?:\/\/[^\s<]+)|(\bwww\.[^\s<]+)|([^\s<@]+@[^\s<@]+\.[^\s<@]+)/gi;
const TRAILING = /[.,;:!?)\]}>'"]+$/;

export function linkifyText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    const start = m.index;
    if (start > last) out.push(text.slice(last, start));
    // Don't swallow sentence punctuation that trails a link.
    const trail = TRAILING.exec(raw)?.[0] ?? "";
    const link = trail ? raw.slice(0, -trail.length) : raw;
    const href = m[3] ? `mailto:${link}` : m[2] ? `https://${link}` : link;
    out.push(
      <a
        key={start}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {link}
      </a>,
    );
    if (trail) out.push(trail);
    last = start + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
