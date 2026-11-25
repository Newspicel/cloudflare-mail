import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "" : window.location.origin,
  plugins: [
    // Keep in sync with auth.ts user.additionalFields so updateUser is typed.
    inferAdditionalFields({ user: { preferences: { type: "string", required: false } } }),
    adminClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        if (typeof window !== "undefined") {
          // Carry the query along: mid-OAuth it holds the signed authorization
          // request the 2FA step has to resume.
          window.location.assign(`/two-factor${window.location.search}`);
        }
      },
    }),
    passkeyClient(),
    // Signs the page's OAuth query into sign-in/consent requests, so signing in
    // from an MCP client's authorization redirect resumes that authorization.
    oauthProviderClient(),
  ],
});

// Mid-OAuth, sign-in and consent answer with where to go next (the client's
// redirect_uri, or the consent page). Follow it; return false when there's none.
export function followOAuthRedirect(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const { redirect, url } = data as { redirect?: unknown; url?: unknown };
  if (redirect !== true || typeof url !== "string") return false;
  window.location.assign(url);
  return true;
}
