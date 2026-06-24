// Downscale an image in the browser so it leaves as a smaller attachment.
// Re-encodes through a canvas, which also drops all metadata as a side effect.
// Formats we can't safely re-encode (e.g. animated GIF, SVG) are left alone.

export function canDownscale(type: string): boolean {
  return type === "image/jpeg" || type === "image/png" || type === "image/webp";
}

// Fit the image within `maxDim` on its longest edge. Returns the original file
// when it's already smaller, when re-encoding would inflate it, or on failure —
// resizing must never block attaching.
export async function downscaleImage(file: File, maxDim: number): Promise<File> {
  if (!canDownscale(file.type) || maxDim <= 0) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxDim) {
      bitmap.close();
      return file;
    }
    const scale = maxDim / longest;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // PNG stays lossless (quality is ignored); JPEG/WebP re-encode at 0.85.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, 0.85),
    );
    // Keep whichever is smaller — re-encoding a PNG photo can inflate it.
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: file.type });
  } catch {
    return file;
  }
}
