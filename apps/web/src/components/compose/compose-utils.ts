export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

export type BodyFormat = "text" | "markdown" | "html";

export interface UploadedAttachment {
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // Inline image embedded in the HTML body; `contentId` is its bare cid token,
  // referenced from the body as `cid:<contentId>` and rewritten at send time.
  inline?: boolean;
  contentId?: string;
}

// Marks an <img> in the rich editor as an inline attachment. The preview src
// points at the draft blob; buildBody swaps it for `cid:<contentId>` on send.
export const CID_ATTR = "data-cfmail-cid";

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Rewrite inline-image <img> tags (those carrying CID_ATTR) so their src points
// at `cid:<contentId>` for the outbound HTML, and report which content ids are
// actually still referenced (the user may have deleted an embedded image).
export function resolveInlineImages(html: string): { html: string; usedCids: Set<string> } {
  const usedCids = new Set<string>();
  if (typeof document === "undefined" || !html.includes(CID_ATTR)) {
    return { html, usedCids };
  }
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  for (const img of doc.querySelectorAll(`img[${CID_ATTR}]`)) {
    const cid = img.getAttribute(CID_ATTR);
    if (!cid) continue;
    usedCids.add(cid);
    img.setAttribute("src", `cid:${cid}`);
    img.removeAttribute(CID_ATTR);
  }
  return { html: doc.body.innerHTML, usedCids };
}

// Preview URL for an inline image still held under a draft R2 key.
export function draftBlobUrl(r2Key: string): string {
  return `/api/attachments/draft-blob?key=${encodeURIComponent(r2Key)}`;
}

// Words that usually imply a file is coming, across the languages most likely
// to show up in this inbox. Stems are matched whole (letter boundaries), so
// "attach" won't fire inside an unrelated longer word.
const ATTACHMENT_WORDS = [
  // English
  "attach",
  "attached",
  "attachment",
  "attachments",
  "attaching",
  "enclosed",
  "enclosure",
  "enclosures",
  // German
  "anbei",
  "anhang",
  "anhänge",
  "angehängt",
  "angehaengt",
  "beigefügt",
  "beigefuegt",
  "beiliegend",
  // French
  "ci-joint",
  "ci-jointe",
  "pièce jointe",
  "pièces jointes",
  "piece jointe",
  // Spanish
  "adjunto",
  "adjunta",
  "adjuntos",
  "adjuntas",
  // Italian
  "allegato",
  "allegata",
  "allegati",
  "allegate",
  // Dutch
  "bijlage",
  "bijgevoegd",
  // Portuguese
  "anexo",
  "anexado",
  "anexada",
  "anexados",
];

// Letter-boundary match (Unicode-aware, so umlauts/accents bound correctly).
const ATTACHMENT_MENTION_RE = new RegExp(
  `(?<!\\p{L})(?:${ATTACHMENT_WORDS.join("|")})(?!\\p{L})`,
  "iu",
);

export function mentionsAttachment(body: string): boolean {
  return body.trim().length > 0 && ATTACHMENT_MENTION_RE.test(body);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The base mailbox address an address belongs to, stripping any "+tag"
// sub-address. Returns lowercase "<base>@<domain>", or null if not an address.
export function plusBase(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const local = addr.slice(0, at).split("+")[0] ?? "";
  return `${local}@${addr.slice(at + 1)}`.toLowerCase();
}

export function prefixSubject(s: string, prefix: "Re" | "Fwd"): string {
  const re = prefix === "Re" ? /^re:/i : /^fwd:/i;
  if (re.test(s.trim())) return s;
  return `${prefix}: ${s}`;
}

// Dedupes a recipient list (case-insensitive), dropping any address in `exclude`.
export function uniqueRecipients(
  items: { name?: string; address: string }[],
  exclude: Set<string>,
): { name?: string; address: string }[] {
  const out: { name?: string; address: string }[] = [];
  const seen = new Set(exclude);
  for (const a of items) {
    const key = a.address.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ address: a.address, name: a.name });
  }
  return out;
}

// Only OS file drags carry the "Files" type, so other drag types never trip
// the attach overlay.
export function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}
