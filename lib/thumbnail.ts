/**
 * Build a small WebP preview in the browser, at upload time.
 *
 * The server can already generate thumbnails, but only lazily on first view, and
 * doing so costs a full download of the original back out of Telegram plus a
 * `sharp` resize — so the first person to scroll a folder waits on it. The
 * browser already has the bytes in memory, so making the thumbnail here is
 * effectively free and the grid never blocks.
 */

const MAX_EDGE = 400;
const QUALITY = 0.72;
/** Above this, decoding client-side risks janking or OOM-ing a phone. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

export function canThumbnail(file: File) {
  return (
    file.type.startsWith("image/") &&
    !file.type.includes("heic") &&
    !file.type.includes("heif") &&
    !file.type.includes("svg") &&
    file.size <= MAX_SOURCE_BYTES &&
    typeof createImageBitmap === "function"
  );
}

export async function makeThumbnail(file: File): Promise<Blob | null> {
  if (!canThumbnail(file)) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", QUALITY));
    // Safari may ignore the WebP request and hand back a PNG; that still works,
    // it is just larger, so only reject an empty result.
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}
