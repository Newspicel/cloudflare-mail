// Transport for Client ID Metadata Documents: an MCP client names itself by an
// HTTPS URL, and the OAuth provider fetches that URL to learn its name and
// redirect URIs. The URL is attacker-chosen, so the fetch runs behind the same
// SSRF guard as every other server-side fetch (ssrf.ts). Better Auth asks the
// transport to pin the resolved address; a Worker can't (its fetch resolves on
// Cloudflare's edge, which doesn't route to private ranges anyway — see the
// DNS-rebinding note in ssrf.ts), so this does what the platform allows:
// HTTPS only, public hosts only, and redirects handed back unfollowed.

import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { isBlockedHost } from "./ssrf.ts";

export const fetchClientMetadataResource: ClientMetadataResourceFetch = (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.protocol !== "https:") throw new TypeError("client metadata must be served over HTTPS");
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new TypeError("client metadata is only ever read");
  }
  if (isBlockedHost(url.hostname)) throw new TypeError("client metadata host is not public");
  return fetch(req, { redirect: "manual" });
};
