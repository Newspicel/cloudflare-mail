import { describe, expect, it } from "vitest";
import { SANDBOX } from "./email-frame.tsx";

// Security guard: the email body iframe is same-origin (srcDoc +
// allow-same-origin, so the parent can measure it and proxied images resolve).
// Granting allow-scripts on top of that would let any sanitizer bypass execute
// with full access to the app origin — i.e. XSS. This test pins the invariant.
describe("EmailFrame sandbox", () => {
  const tokens = SANDBOX.split(/\s+/).filter(Boolean);

  it("never grants allow-scripts", () => {
    expect(tokens).not.toContain("allow-scripts");
  });

  it("keeps allow-same-origin inert by not pairing it with script-capable grants", () => {
    // These would each give framed content a way to run or smuggle script.
    for (const dangerous of [
      "allow-scripts",
      "allow-modals",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-forms",
    ]) {
      expect(tokens).not.toContain(dangerous);
    }
  });

  it("grants same-origin (needed for measuring) and popup escape only", () => {
    expect(new Set(tokens)).toEqual(
      new Set(["allow-same-origin", "allow-popups", "allow-popups-to-escape-sandbox"]),
    );
  });
});
