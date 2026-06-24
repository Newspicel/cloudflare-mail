import piexif from "piexifjs";

// Lossless removal of privacy-sensitive image metadata (EXIF/GPS, text chunks)
// before an image leaves the browser. "Lossless" = the pixel data is never
// re-encoded; we only drop metadata segments/chunks, so quality and size are
// preserved. Formats we can't safely rewrite are returned untouched.

export function canStripMetadata(type: string): boolean {
  return type === "image/jpeg" || type === "image/png";
}

export async function stripImageMetadata(file: File): Promise<File> {
  try {
    if (file.type === "image/jpeg") return await stripJpeg(file);
    if (file.type === "image/png") return await stripPng(file);
  } catch {
    // Never block attaching on a strip failure — fall back to the original.
  }
  return file;
}

// JPEG: piexifjs rewrites the file without the APP1/Exif segment. It throws
// when there's no Exif to remove, in which case the original is already clean.
async function stripJpeg(file: File): Promise<File> {
  const dataUrl = await fileToDataUrl(file);
  let cleaned: string;
  try {
    cleaned = piexif.remove(dataUrl);
  } catch {
    return file;
  }
  const bytes = dataUrlToBytes(cleaned);
  return new File([bytes as BlobPart], file.name, { type: file.type });
}

// PNG: walk the chunk stream and drop ancillary metadata chunks. Critical
// chunks (IHDR/PLTE/IDAT/IEND) and render-affecting ancillary chunks are kept,
// so the image renders identically. CRCs of kept chunks are untouched.
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "dSIG"]);

async function stripPng(file: File): Promise<File> {
  const buf = new Uint8Array(await file.arrayBuffer());
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return file; // not a real PNG
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Uint8Array[] = [buf.subarray(0, 8)];
  let offset = 8;
  let changed = false;
  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...buf.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length; // length + 4 type + 4 crc
    if (end > buf.length) break; // truncated — bail and keep original
    if (PNG_DROP.has(type)) {
      changed = true;
    } else {
      out.push(buf.subarray(offset, end));
    }
    if (type === "IEND") break;
    offset = end;
  }
  if (!changed) return file;
  return new File(out as BlobPart[], file.name, { type: file.type });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(file);
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
