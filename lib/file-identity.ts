/**
 * How a file is identified, on the two axes an upload cares about.
 *
 * `resumeKeyFor` is *session* identity — is this the same upload I started
 * before? `fingerprint` is *content* identity — do I already have these bytes?
 * They live together, in a module that imports nothing, because they are the two
 * questions every upload asks before it sends anything, and because importing
 * nothing is what lets scripts/check-dedupe.mjs run them without a browser.
 */

/**
 * Stable fingerprint for one file. The server keys the in-progress upload on it,
 * so closing the tab or losing the network mid-file resumes from the chunks that
 * already landed instead of starting over.
 *
 * Deliberately *not* folder-aware, though it used to be. /api/upload/init already
 * filters the session it hands back by folder and size alongside this key, so the
 * folder id here was redundant — and worse than redundant: a directory upload
 * only learns its real destination once the folder chain has been created, so the
 * key changed underneath a resume and the server started a brand-new session,
 * abandoning every chunk it was already holding. Keyed on the file alone, the
 * stored file handle and the server session finally agree.
 */
export function resumeKeyFor(file: { name: string; size: number; lastModified: number }) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/**
 * A content fingerprint for "have I already uploaded this file?".
 *
 * WebCrypto has no incremental digest — `crypto.subtle.digest` wants the whole
 * buffer — so hashing a 2 GB file for real would mean holding 2 GB in memory or
 * adding a WASM hashing dependency and spending ~15 s of CPU before a single
 * byte goes to Telegram, on every file, every time.
 *
 * So the digest is taken over the size plus up to three 1 MiB windows: the head,
 * the middle and the tail. A file of 3 MiB or less is covered end to end, which
 * is a genuine full-content SHA-256. Anything larger is a fingerprint: constant
 * time, 3 MB of memory, and specific enough that two different files of exactly
 * the same byte length agreeing on all three windows is not something a personal
 * drive runs into.
 *
 * ponytail: sampled digest — two same-size files differing only outside the
 * sampled windows collide. Upgrade path is incremental SHA-256 (hash-wasm) if
 * that ever bites; the stored value is prefixed so both schemes can coexist.
 */

const WINDOW = 1024 * 1024;

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Byte ranges to digest: head, middle and tail, merged where they overlap. */
function windows(size: number): Array<[number, number]> {
  if (size <= WINDOW * 3) return [[0, size]];
  const middle = Math.floor(size / 2 - WINDOW / 2);
  return [
    [0, WINDOW],
    [middle, middle + WINDOW],
    [size - WINDOW, size]
  ];
}

/**
 * `sha256:<hex>` for a file, or null where the browser has no SubtleCrypto.
 *
 * Null is not a failure — duplicate detection is a courtesy, and an upload must
 * never be blocked because a digest could not be taken (Safari over plain HTTP
 * exposes no `crypto.subtle` at all). The server treats a missing hash as
 * "unknown, upload it".
 */
export async function fingerprint(file: File): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    // The size leads the digest so two files that share every sampled window but
    // differ in length can never collide.
    const parts: BlobPart[] = [new TextEncoder().encode(`${file.size}:`)];
    for (const [start, end] of windows(file.size)) parts.push(file.slice(start, end));
    const bytes = await new Blob(parts).arrayBuffer();
    return `sha256:${toHex(await crypto.subtle.digest("SHA-256", bytes))}`;
  } catch {
    return null;
  }
}

/**
 * Fingerprint a batch, a few at a time.
 *
 * Serial would make a 200-file folder wait on 200 sequential disk reads; all at
 * once would open 200 file streams and blow up memory on a folder of large
 * files. `onProgress` drives the "Checking 30 of 200…" toast.
 */
export async function fingerprintAll(
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<Array<string | null>> {
  const out = new Array<string | null>(files.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      out[i] = await fingerprint(files[i]);
      onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length || 1) }, worker));
  return out;
}
