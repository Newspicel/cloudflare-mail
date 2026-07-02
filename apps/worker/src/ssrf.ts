// Shared SSRF guard. Both the remote-image proxy (`mail/img-proxy.ts` +
// `/proxy-image`) and the Web Push registration (`api/push.ts`) fetch
// attacker-influenced URLs server-side, so both must refuse to be steered at
// internal/reserved targets. A literal-hostname string match is not enough:
// IPv4 has several equivalent encodings (decimal `2130706433`, hex
// `0x7f000001`, short `127.1`) that all resolve to loopback, so we canonicalize
// to an integer before range-checking. DNS rebinding (a public name with an
// internal A record) can't be fully closed here — Workers `fetch` doesn't let
// us pin the resolved IP — but on the edge RFC1918/loopback aren't routable
// anyway; the residual risk is Cloudflare-internal/metadata and
// publicly-addressable-but-firewalled services.

/**
 * Canonicalize an IPv4 literal in any inet_aton form (1–4 dotted parts, each
 * decimal/octal/hex) to a 32-bit int, or null if `host` isn't an IPv4 literal.
 */
function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p))
      n = parseInt(p, 8); // leading zero → octal
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // a non-numeric label means this is a hostname, not an IP
    if (!Number.isInteger(n) || n < 0) return null;
    vals.push(n);
  }
  // inet_aton folding: the final part absorbs all remaining low-order bytes.
  const last = vals.pop() as number;
  let ip = 0;
  for (const v of vals) {
    if (v > 255) return null;
    ip = ip * 256 + v;
  }
  const remBytes = 4 - vals.length;
  if (last >= 2 ** (8 * remBytes)) return null;
  ip = ip * 2 ** (8 * remBytes) + last;
  return ip >>> 0;
}

function isBlockedIpv4(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // any-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups: expand `::`, strip a zone
 * index, and fold a dotted-IPv4 tail (`::ffff:127.0.0.1`) into its two hex
 * groups. Returns null when the literal is malformed.
 */
function parseIpv6(host: string): number[] | null {
  let h = host;
  const zone = h.indexOf("%");
  if (zone !== -1) h = h.slice(0, zone);

  // Dotted-IPv4 tail → two 16-bit groups, so both `::ffff:127.0.0.1` and its
  // hex form `::ffff:7f00:1` parse identically.
  const lastColon = h.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    const parts = tail.split(".");
    if (parts.length !== 4) return null;
    const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
    if (bytes.some((b) => !Number.isInteger(b) || b > 255)) return null;
    const v4 = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    h = `${h.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  let groups: string[];
  const dbl = h.indexOf("::");
  if (dbl !== -1) {
    if (dbl !== h.lastIndexOf("::")) return null; // more than one `::`
    const head = h.slice(0, dbl).split(":").filter(Boolean);
    const rest = h
      .slice(dbl + 2)
      .split(":")
      .filter(Boolean);
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  } else {
    groups = h.split(":");
    if (groups.length !== 8) return null;
  }

  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function isBlockedIpv6(g: number[]): boolean {
  const first5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // Unspecified (::) and loopback (::1).
  if (first5Zero && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast ff00::/8
  const embedded = (((g[6]! << 16) | g[7]!) >>> 0) as number;
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — range-check the
  // embedded v4 regardless of how it was written (dotted or hex groups).
  if (first5Zero && (g[5] === 0xffff || g[5] === 0)) return isBlockedIpv4(embedded);
  // NAT64 well-known prefix 64:ff9b::/96 — same embedded-v4 check.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4(embedded);
  }
  return false;
}

/** Best-effort block of internal/reserved targets for IP-literal/internal hosts. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (h.includes(":")) {
    const groups = parseIpv6(h);
    // A colon means an IPv6 literal or nothing valid — block malformed ones.
    return groups === null || isBlockedIpv6(groups);
  }
  const ip = ipv4ToInt(h);
  if (ip !== null) return isBlockedIpv4(ip);
  return false; // ordinary hostname — allowed (see DNS-rebinding note above)
}

/**
 * Fetch `initial`, following redirects manually so every hop is re-validated
 * against {@link isBlockedHost} and the http(s) scheme allowlist. `redirect:
 * "follow"` would let an attacker-controlled public host 302 us straight at an
 * internal address. Returns the first non-redirect response.
 */
export async function safeRedirectFetch(
  initial: URL,
  init: RequestInit,
  maxHops = 5,
): Promise<Response | { blocked: true; reason: string }> {
  let target = initial;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (target.protocol !== "http:" && target.protocol !== "https:")
      return { blocked: true, reason: "blocked scheme" };
    if (isBlockedHost(target.hostname)) return { blocked: true, reason: "blocked host" };

    // eslint-disable-next-line no-await-in-loop -- each hop depends on the prior response
    const res = await fetch(target, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get("location");
    if (!loc) return res; // redirect with no target — let caller treat as non-2xx
    try {
      target = new URL(loc, target);
    } catch {
      return { blocked: true, reason: "bad redirect target" };
    }
  }
  return { blocked: true, reason: "too many redirects" };
}
