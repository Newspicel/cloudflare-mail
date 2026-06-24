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
          window.location.assign("/two-factor");
        }
      },
    }),
    passkeyClient(),
  ],
});
