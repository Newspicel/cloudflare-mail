import { unzipSync } from "fflate";

// Client-side extraction of exported mail. The browser unpacks .eml/.mbox/.zip
// and uploads one raw RFC822 message per request, so each call stays within the
// Worker's body/CPU limits no matter how large the export is.

export interface ImportProgress {
  total: number;
  done: number;
  duplicate: number;
  failed: number;
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

function fromEntry(path: string, bytes: Uint8Array): Uint8Array[] {
  const name = path.toLowerCase();
  if (name.endsWith(".mbox")) return splitMbox(bytes);
  if (name.endsWith(".eml")) return [bytes];
  return [];
}

async function extractFile(file: File): Promise<Uint8Array[]> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".zip")) {
    return Object.entries(unzipSync(bytes)).flatMap(([path, b]) => fromEntry(path, b));
  }
  if (name.endsWith(".mbox")) return splitMbox(bytes);
  // .eml or anything else: treat the whole file as a single message.
  return [bytes];
}

// fetch's BodyInit accepts ArrayBuffer cleanly (unlike the now-generic
// Uint8Array type); hand it the exact bytes, copying only a partial view.
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) return u.buffer as ArrayBuffer;
  return u.slice().buffer as ArrayBuffer;
}

async function uploadOne(mailboxId: string, eml: Uint8Array): Promise<{ duplicate: boolean }> {
  const res = await fetch(`/api/mailboxes/${mailboxId}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "message/rfc822" },
    body: toArrayBuffer(eml),
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
  const emls = (await Promise.all(files.map(extractFile))).flat();

  const progress: ImportProgress = { total: emls.length, done: 0, duplicate: 0, failed: 0 };
  onProgress({ ...progress });

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= emls.length) return;
      try {
        // eslint-disable-next-line no-await-in-loop -- a worker drains items sequentially; parallelism is across workers
        const res = await uploadOne(mailboxId, emls[i]!);
        if (res.duplicate) progress.duplicate++;
      } catch {
        progress.failed++;
      }
      progress.done++;
      onProgress({ ...progress });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, emls.length) }, worker));
  return progress;
}
