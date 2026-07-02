import { useEffect, useState } from "react";

// DOMPurify + marked (~140KB) are only needed once a composer is actually open,
// so they're loaded on demand rather than dragged into the initial bundle that
// every (including read-only) user pays for on first paint. The promise is
// memoized so both ComposeForm instances and repeated opens share one load.
export type MarkdownLibs = {
  marked: typeof import("marked").marked;
  DOMPurify: typeof import("dompurify").default;
};

let markdownLibs: MarkdownLibs | null = null;
let markdownLibsPromise: Promise<MarkdownLibs> | null = null;

export function loadMarkdownLibs(): Promise<MarkdownLibs> {
  if (markdownLibs) return Promise.resolve(markdownLibs);
  markdownLibsPromise ??= Promise.all([import("marked"), import("dompurify")]).then(
    ([{ marked }, { default: DOMPurify }]) => {
      marked.setOptions({ breaks: true, gfm: true });
      markdownLibs = { marked, DOMPurify };
      return markdownLibs;
    },
  );
  return markdownLibsPromise;
}

// Pull in marked/DOMPurify as soon as a composer mounts so the markdown
// preview and the sanitized send path have them ready by the time they fire.
export function useMarkdownLibs(): MarkdownLibs | null {
  const [mdLibs, setMdLibs] = useState<MarkdownLibs | null>(markdownLibs);
  // Preload marked/DOMPurify on mount so preview/send have them ready — a
  // genuine mount-time side effect, not a substitute for an event handler.
  useEffect(() => {
    // react-doctor-disable-next-line no-event-handler -- no triggering event; preloads a module on mount
    if (!mdLibs) void loadMarkdownLibs().then(setMdLibs);
  }, [mdLibs]);
  return mdLibs;
}
