// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMailto } from "./mailto.ts";
import { handleMailtoClick } from "./use-mailto-links.ts";

// The point of the interception: a mailto click must never reach the browser's
// default handling (which hands it to the OS mail client).
function click(html: string, init: MouseEventInit = {}): MouseEvent {
  document.body.innerHTML = html;
  const a = document.body.querySelector("a") as HTMLAnchorElement;
  const e = new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  a.dispatchEvent(e);
  return e;
}

describe("handleMailtoClick", () => {
  beforeEach(() => {
    document.addEventListener("click", handleMailtoClick);
    // No <ComposeDock> is mounted in this test, so the store opens a window.
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    return () => {
      document.removeEventListener("click", handleMailtoClick);
      vi.unstubAllGlobals();
    };
  });

  it("swallows a mailto click and opens the composer", () => {
    const e = click(`<a href="mailto:a@b.com?subject=Hi&cc=c@d.com">mail</a>`);
    expect(e.defaultPrevented).toBe(true);
    const opened = vi.mocked(window.open).mock.calls[0]?.[0] as string;
    // The composer URL must survive the round trip back into mailto fields.
    const url = new URL(opened, "https://mail.test");
    expect(url.pathname).toBe("/compose");
    expect(parseMailto(url.searchParams.get("mailto") ?? "")).toEqual({
      to: ["a@b.com"],
      cc: ["c@d.com"],
      bcc: [],
      subject: "Hi",
    });
  });

  it("catches a click on a child of the anchor", () => {
    expect(click(`<a href="MAILTO:a@b.com"><span>x</span></a>`).defaultPrevented).toBe(true);
  });

  it("leaves other schemes and modified clicks alone", () => {
    expect(click(`<a href="https://example.com">x</a>`).defaultPrevented).toBe(false);
    expect(click(`<a href="mailto:a@b.com">x</a>`, { metaKey: true }).defaultPrevented).toBe(false);
  });
});
