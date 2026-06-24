import { unzipSync } from "fflate";

// Client-side extraction of exported mail. The browser unpacks .eml/.mbox/.zip
// (or a directly-selected export folder) and uploads one raw RFC822 message per
// request, so each call stays within the Worker's body/CPU limits no matter how
// large the export is.
//
// A Proton Mail export is a flat directory of <id>.eml + <id>.metadata.json
// pairs plus a labels.json catalog. The .eml files are plain RFC822, so they
// import like any other; the sidecar metadata carries read/star state and the
// Spam/Trash placement, which we apply via per-message query params. Selecting
// the folder directly (rather than zipping it) lets the browser read each
// message lazily, so a multi-GB export never has to fit in memory at once.

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

const META_SUFFIX = ".metadata.json";

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
    const labels: string[] = Array.isArray(payload.LabelIDs) ? payload.LabelIDs.map(String) : [];
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

function u8(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
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

// Lazily-evaluated unit of work: produces a single message to upload. Bodies are
// resolved here (not up front) so a large folder selection reads at most
// `concurrency` messages into memory at a time.
type Task = () => Promise<ImportItem>;

// Build the upload tasks from the selection. Sidecar metadata is indexed first
// so each .eml can pick up its read/star/folder state by base name.
async function plan(files: File[]): Promise<Task[]> {
  const stateByBase = new Map<string, ImportState>();
  const tasks: Task[] = [];

  const registerMeta = (name: string, bytes: Uint8Array) => {
    const st = parseProtonState(bytes);
    if (st) stateByBase.set(name.slice(0, -META_SUFFIX.length), st);
  };

  // Route in-memory bytes (a zip entry) into the metadata index or an upload task.
  const routeBytes = (name: string, bytes: Uint8Array) => {
    const lower = name.toLowerCase();
    if (lower.endsWith(META_SUFFIX) || lower === "labels.json") return;
    if (lower.endsWith(".mbox")) {
      for (const raw of splitMbox(bytes)) tasks.push(async () => ({ raw }));
    } else if (lower.endsWith(".eml")) {
      tasks.push(async () => ({ raw: bytes, state: stateByBase.get(name.slice(0, -4)) }));
    } else if (!lower.endsWith(".json")) {
      tasks.push(async () => ({ raw: bytes }));
    }
  };

  const looseMessages: File[] = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      // A zip is fully in memory once unpacked; two-pass its entries so .eml
      // items can resolve metadata that may appear after them.
      // eslint-disable-next-line no-await-in-loop -- one archive at a time bounds peak memory
      const entries = Object.entries(unzipSync(u8(await file.arrayBuffer())))
        .filter(([p]) => !p.endsWith("/"))
        .map(([p, b]) => [basename(p), b] as const);
      for (const [name, b] of entries) {
        if (name.toLowerCase().endsWith(META_SUFFIX)) registerMeta(name, b);
      }
      for (const [name, b] of entries) routeBytes(name, b);
    } else if (lower.endsWith(META_SUFFIX)) {
      // eslint-disable-next-line no-await-in-loop -- sidecars are tiny; sequential reads are fine
      registerMeta(file.name, u8(await file.arrayBuffer()));
    } else if (lower !== "labels.json" && !lower.endsWith(".json")) {
      looseMessages.push(file);
    }
  }

  // Loose files (a selected folder or individually-picked messages) are read
  // lazily at upload time. .mbox must be split now, but those are one-off.
  for (const f of looseMessages) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".mbox")) {
      // eslint-disable-next-line no-await-in-loop -- mbox archives are rare and read one at a time
      for (const raw of splitMbox(u8(await f.arrayBuffer()))) tasks.push(async () => ({ raw }));
    } else {
      const state = lower.endsWith(".eml") ? stateByBase.get(f.name.slice(0, -4)) : undefined;
      tasks.push(async () => ({ raw: u8(await f.arrayBuffer()), state }));
    }
  }

  return tasks;
}

export async function runImport(
  mailboxId: string,
  files: File[],
  onProgress: (p: ImportProgress) => void,
  concurrency = 3,
): Promise<ImportProgress> {
  const tasks = await plan(files);

  const progress: ImportProgress = { total: tasks.length, done: 0, duplicate: 0, failed: 0 };
  onProgress({ ...progress });

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        // eslint-disable-next-line no-await-in-loop -- a worker drains items sequentially; parallelism is across workers
        const res = await uploadOne(mailboxId, await tasks[i]!());
        if (res.duplicate) progress.duplicate++;
      } catch {
        progress.failed++;
      }
      progress.done++;
      onProgress({ ...progress });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return progress;
}
