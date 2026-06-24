import { unzipSync } from "fflate";

// Client-side extraction of exported mail. The browser unpacks .eml/.mbox/.zip
// and uploads one raw RFC822 message per request, so each call stays within the
// Worker's body/CPU limits no matter how large the export is.
//
// A Proton Mail export is a flat directory of <id>.eml + <id>.metadata.json
// pairs plus a labels.json catalog. The .eml files are plain RFC822, so they
// import like any other; the sidecar metadata carries read/star state and the
// Spam/Trash placement, which we apply via per-message query params.

export interface ImportProgress {
  total: number;
  done: number;
  duplicate: number;
  failed: number;
}

// Per-message state recovered from an export's sidecar metadata.
interface ImportState {
  seen: boolean;
  starred: boolean;
  trashed: boolean;
  spam: boolean;
}

interface ImportItem {
  raw: Uint8Array;
  state?: ImportState;
}

// Round-trip bytes through latin1 so 8-bit MIME content survives the split
// unchanged (UTF-8 decode/re-encode would corrupt non-ASCII attachment bytes).
const latin1 = new TextDecoder("latin1");
function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Split an mbox archive into individual messages. Messages are separated by a
// line beginning "From " (the mbox separator); mboxrd escapes body lines that
// would otherwise look like one as ">From ", which we unescape.
function splitMbox(bytes: Uint8Array): Uint8Array[] {
  const text = latin1.decode(bytes);
  const out: Uint8Array[] = [];
  for (let part of text.split(/\r?\n(?=From )/)) {
    part = part.replace(/^From [^\n]*\r?\n/, "").replace(/^>(>*From )/gm, "$1");
    if (part.trim()) out.push(encodeLatin1(part));
  }
  return out;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// Proton's well-known system label IDs (from labels.json). Custom labels carry
// opaque hashed IDs, which we ignore.
const PROTON_TRASH = "3";
const PROTON_SPAM = "4";
const PROTON_STARRED = "10";

// Derive import state from a Proton <id>.metadata.json sidecar. Returns
// undefined for anything that doesn't look like Proton metadata.
function parseProtonState(bytes: Uint8Array): ImportState | undefined {
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes))?.Payload;
    if (!payload) return undefined;
    const labels: string[] = Array.isArray(payload.LabelIDs)
      ? payload.LabelIDs.map(String)
      : [];
    return {
      seen: !payload.Unread,
      starred: labels.includes(PROTON_STARRED),
      trashed: labels.includes(PROTON_TRASH),
      spam: labels.includes(PROTON_SPAM),
    };
  } catch {
    return undefined;
  }
}

// Flatten every selected file (and the contents of any .zip) into a single
// basename → bytes map, so sidecar metadata can be paired with its .eml even
// when the two arrive as separate files or separate zip entries.
async function collectEntries(files: File[]): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- sequential reads keep peak memory bounded
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (file.name.toLowerCase().endsWith(".zip")) {
      for (const [path, b] of Object.entries(unzipSync(bytes))) {
        if (!path.endsWith("/")) entries.set(basename(path), b);
      }
    } else {
      entries.set(file.name, bytes);
    }
  }
  return entries;
}

function buildItems(entries: Map<string, Uint8Array>): ImportItem[] {
  const items: ImportItem[] = [];
  for (const [path, bytes] of entries) {
    const lower = path.toLowerCase();
    // Sidecars are consumed only when pairing with their .eml; never on their own.
    if (lower.endsWith(".metadata.json") || lower === "labels.json") continue;
    if (lower.endsWith(".mbox")) {
      for (const raw of splitMbox(bytes)) items.push({ raw });
      continue;
    }
    if (lower.endsWith(".eml")) {
      const meta = entries.get(`${path.slice(0, -4)}.metadata.json`);
      items.push({ raw: bytes, state: meta ? parseProtonState(meta) : undefined });
      continue;
    }
    // Other JSON is export bookkeeping we don't import; anything else is a message.
    if (lower.endsWith(".json")) continue;
    items.push({ raw: bytes });
  }
  return items;
}

// fetch's BodyInit accepts ArrayBuffer cleanly (unlike the now-generic
// Uint8Array type); hand it the exact bytes, copying only a partial view.
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) return u.buffer as ArrayBuffer;
  return u.slice().buffer as ArrayBuffer;
}

async function uploadOne(mailboxId: string, item: ImportItem): Promise<{ duplicate: boolean }> {
  const q = new URLSearchParams();
  const s = item.state;
  if (s) {
    if (!s.seen) q.set("seen", "0");
    if (s.starred) q.set("starred", "1");
    if (s.trashed) q.set("trashed", "1");
    if (s.spam) q.set("spam", "1");
  }
  const qs = q.toString();
  const res = await fetch(`/api/mailboxes/${mailboxId}/import${qs ? `?${qs}` : ""}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "message/rfc822" },
    body: toArrayBuffer(item.raw),
  });
  if (!res.ok) throw new Error(`import failed (${res.status})`);
  return (await res.json()) as { duplicate: boolean };
}

export async function runImport(
  mailboxId: string,
  files: File[],
  onProgress: (p: ImportProgress) => void,
  concurrency = 3,
): Promise<ImportProgress> {
  const items = buildItems(await collectEntries(files));

  const progress: ImportProgress = { total: items.length, done: 0, duplicate: 0, failed: 0 };
  onProgress({ ...progress });

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        // eslint-disable-next-line no-await-in-loop -- a worker drains items sequentially; parallelism is across workers
        const res = await uploadOne(mailboxId, items[i]!);
        if (res.duplicate) progress.duplicate++;
      } catch {
        progress.failed++;
      }
      progress.done++;
      onProgress({ ...progress });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return progress;
}
