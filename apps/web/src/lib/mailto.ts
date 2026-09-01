// RFC 6068 mailto: URLs — `mailto:a@b.com,c@d.com?cc=…&subject=…&body=…`.
// Parsed in-app so a mailto link opens the composer instead of handing the
// click to the OS mail client (and so the PWA can register as the system
// mailto handler and be launched with one).

export interface MailtoFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
}

// The mailto query is *not* form-encoded, so `+` is a literal plus (it's legal
// in a local part) — decodeURIComponent, never URLSearchParams. A malformed
// escape decodes to itself rather than throwing away the whole link.
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function addresses(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => decode(a).trim())
    .filter(Boolean);
}

export function parseMailto(href: string): MailtoFields | null {
  if (!/^mailto:/i.test(href)) return null;
  const rest = href.slice("mailto:".length);
  const q = rest.indexOf("?");
  const out: MailtoFields = { to: addresses(q === -1 ? rest : rest.slice(0, q)), cc: [], bcc: [] };
  if (q !== -1) {
    for (const pair of rest.slice(q + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = decode(eq === -1 ? pair : pair.slice(0, eq))
        .trim()
        .toLowerCase();
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      if (key === "to") out.to.push(...addresses(value));
      else if (key === "cc") out.cc.push(...addresses(value));
      else if (key === "bcc") out.bcc.push(...addresses(value));
      else if (key === "subject") out.subject = decode(value);
      else if (key === "body") out.body = decode(value);
      // Other headers (in-reply-to, …) aren't composable here — ignore them.
    }
  }
  return out;
}

// Inverse of the above: serialize seeded compose fields back into a mailto URL,
// so a pop-out window can carry them in `/compose?mailto=…`.
export function buildMailto(f: Partial<MailtoFields>): string {
  const params: string[] = [];
  const add = (key: string, list: string[] | undefined) => {
    if (list?.length) params.push(`${key}=${encodeURIComponent(list.join(","))}`);
  };
  add("cc", f.cc);
  add("bcc", f.bcc);
  if (f.subject) params.push(`subject=${encodeURIComponent(f.subject)}`);
  if (f.body) params.push(`body=${encodeURIComponent(f.body)}`);
  const to = (f.to ?? []).map(encodeURIComponent).join(",");
  return `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
}
