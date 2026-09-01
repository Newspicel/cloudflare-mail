import { useEffect } from "react";
import { openMailto } from "@/components/compose/compose-store.ts";

// A modified click (new tab/window, middle button) keeps its default handling.
function plainClick(e: MouseEvent): boolean {
  return (
    !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
  );
}

// Sends a `mailto:` anchor click to the in-app composer instead of the OS mail
// client. Shared by the app DOM (linkified plain-text bodies, addresses) and by
// the sandboxed message iframe, which has its own document to listen on.
export function handleMailtoClick(e: MouseEvent): void {
  if (!plainClick(e)) return;
  const target = e.target as Element | null;
  const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  const href = a?.getAttribute("href");
  if (!href || !/^mailto:/i.test(href)) return;
  e.preventDefault();
  openMailto(href);
}

// Installs the delegated listener for the app's own DOM.
export function useMailtoLinks(): void {
  useEffect(() => {
    document.addEventListener("click", handleMailtoClick);
    return () => document.removeEventListener("click", handleMailtoClick);
  }, []);
}
