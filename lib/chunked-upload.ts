import { UploadAbortedError } from "@/lib/api-client";
import { resumeKeyFor } from "@/lib/file-identity";
import { CHUNK_SIZE, CHUNK_CONCURRENCY, type UploadBackend } from "@/lib/upload-config";

const MAX_RETRIES = 5;

export type UploadedFileMeta = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageMode: "BOT" | "PERSONAL";
  backend: UploadBackend;
  folderId: string | null;
  isFavorite: boolean;
  createdAt: string;
};

/** Full-jitter backoff — keeps a room full of retrying uploaders from
 *  synchronising into a second thundering herd. */
function retryDelay(attempt: number) {
  return Math.random() * Math.min(1500 * 2 ** attempt, 30_000);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isAbort(err: unknown) {
  return err instanceof UploadAbortedError || (err instanceof DOMException && err.name === "AbortError");
}

/** Best-effort: the upload has already failed, so a failure to tidy up must not
 *  replace the real error the caller is about to see. */
async function discardSession(fileId: string) {
  try {
    await fetch(`/api/upload/abort/${fileId}`, { method: "DELETE" });
  } catch {
    /* the stale session is garbage-collected server-side instead */
  }
}

async function putChunk(fileId: string, index: number, blob: Blob, signal?: AbortSignal) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new UploadAbortedError();
    try {
      const form = new FormData();
      form.append("chunk", blob);
      const res = await fetch(`/api/upload/chunk/${fileId}/${index}`, { method: "POST", body: form, signal });
      if (res.ok) return;

      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const err = new Error(body.error || `Chunk ${index} failed (HTTP ${res.status}).`);
      // 4xx other than 429 means this chunk will never succeed — fail fast.
      if (res.status < 500 && res.status !== 429) throw err;
      lastErr = err;
    } catch (err) {
      if (isAbort(err)) throw new UploadAbortedError();
      lastErr = err;
    }
    if (attempt < MAX_RETRIES - 1) await sleep(retryDelay(attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Chunk ${index} failed.`);
}

/** The server refused because this file is already stored in that folder. */
export class DuplicateFileError extends Error {
  constructor(readonly existing: { id: string; name: string }) {
    super(`"${existing.name}" is already in this folder.`);
    this.name = "DuplicateFileError";
  }
}

export async function uploadFileInChunks({
  file,
  folderId,
  prefer,
  contentHash,
  allowDuplicate,
  onProgress,
  signal,
}: {
  file: File;
  folderId?: string | null;
  /** The user's storage choice from Settings. The server may decline it. */
  prefer?: string;
  /** Content fingerprint, so the server can refuse a duplicate the user did not ask for. */
  contentHash?: string | null;
  /** The user was shown the duplicate and chose to upload anyway. */
  allowDuplicate?: boolean;
  /** Bytes of this file confirmed stored so far — the caller derives %, speed and ETA. */
  onProgress: (loadedBytes: number) => void;
  signal?: AbortSignal;
}): Promise<{ fileId: string; file: UploadedFileMeta | null }> {
  if (signal?.aborted) throw new UploadAbortedError();

  // 1. Init — creates a session, or hands back the one we left half-finished.
  const initRes = await fetch("/api/upload/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      folderId,
      prefer,
      contentHash,
      allowDuplicate,
      resumeKey: resumeKeyFor(file),
    }),
    signal,
  });
  if (!initRes.ok) {
    const body = (await initRes.json().catch(() => ({}))) as {
      error?: string;
      duplicate?: { id: string; name: string };
    };
    // 409 is the server's half of the duplicate check: the client asks first, but
    // another tab — or a stale answer — can still have stored it since.
    if (initRes.status === 409 && body.duplicate) throw new DuplicateFileError(body.duplicate);
    throw new Error(body.error || "Failed to initialise chunked upload.");
  }
  const {
    fileId,
    totalChunks,
    received = [],
    chunkSizeBytes
  } = (await initRes.json()) as {
    fileId: string;
    totalChunks: number;
    received?: number[];
    chunkSizeBytes?: number;
  };

  // The server owns the chunk size. Taking it from the response rather than the
  // shared constant means an operator can change UPLOAD_CHUNK_MB without
  // stranding an upload that is mid-resume at the old size, and a stale bundle
  // in someone's tab cannot slice at a size the server will reject.
  const chunkSize = chunkSizeBytes && chunkSizeBytes > 0 ? chunkSizeBytes : CHUNK_SIZE;

  // 2. Upload only the chunks that are still missing, a few at a time.
  const done = new Set(received);
  const pending = Array.from({ length: totalChunks }, (_, i) => i).filter(i => !done.has(i));

  let completed = done.size;
  // Bytes, not a percentage: the last chunk is usually short, so multiplying the
  // chunk count would overstate progress at the end of every file. Held just
  // below the total until /complete returns, so the UI never sits at a finished
  // 100% while the file is still being finalised.
  const report = () =>
    onProgress(Math.min(completed * chunkSize, Math.max(0, file.size - 1)));
  report();

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new UploadAbortedError();
      const slot = cursor++;
      if (slot >= pending.length) return;
      const i = pending[slot];
      const start = i * chunkSize;
      await putChunk(fileId, i, file.slice(start, Math.min(start + chunkSize, file.size)), signal);
      completed++;
      report();
    }
  };

  // Promise.all rejects on the first failure, but the other workers keep running
  // until they notice; allSettled lets us surface the real error deterministically.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, Math.max(pending.length, 1)) }, worker)
  );
  const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failure) {
    // A cancel leaves the session alone so the user can resume it. Any other
    // failure has exhausted its retries, so the half-created row is discarded
    // rather than left in the drive as a phantom file of the full size.
    if (!isAbort(failure.reason)) await discardSession(fileId);
    throw failure.reason;
  }

  // 3. Complete
  if (signal?.aborted) throw new UploadAbortedError();
  const completeRes = await fetch(`/api/upload/complete/${fileId}`, { method: "POST", signal });
  if (!completeRes.ok) {
    const body = (await completeRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to complete chunked upload.");
  }
  const completeBody = (await completeRes.json().catch(() => ({}))) as { file?: UploadedFileMeta };

  onProgress(file.size);
  return { fileId, file: completeBody.file ?? null };
}
