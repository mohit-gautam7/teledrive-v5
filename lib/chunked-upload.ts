import { UploadAbortedError } from "@/lib/api-client";
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

/**
 * Stable fingerprint for one (file, destination) pair. The server keys the
 * in-progress upload on it, so closing the tab or losing the network mid-file
 * resumes from the chunks that already landed instead of starting over.
 */
export function resumeKeyFor(file: File, folderId?: string | null) {
  return `${file.name}|${file.size}|${file.lastModified}|${folderId ?? "root"}`;
}

/** Full-jitter backoff — keeps a room full of retrying uploaders from
 *  synchronising into a second thundering herd. */
function retryDelay(attempt: number) {
  return Math.random() * Math.min(1500 * 2 ** attempt, 30_000);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isAbort(err: unknown) {
  return err instanceof UploadAbortedError || (err instanceof DOMException && err.name === "AbortError");
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

export async function uploadFileInChunks({
  file,
  folderId,
  onProgress,
  signal,
}: {
  file: File;
  folderId?: string | null;
  onProgress: (pct: number) => void;
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
      resumeKey: resumeKeyFor(file, folderId),
    }),
    signal,
  });
  if (!initRes.ok) {
    const body = (await initRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to initialise chunked upload.");
  }
  const { fileId, totalChunks, received = [] } = (await initRes.json()) as {
    fileId: string;
    totalChunks: number;
    received?: number[];
  };

  // 2. Upload only the chunks that are still missing, a few at a time.
  const done = new Set(received);
  const pending = Array.from({ length: totalChunks }, (_, i) => i).filter(i => !done.has(i));

  let completed = done.size;
  const report = () => onProgress(Math.round((completed / totalChunks) * 95));
  report();

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new UploadAbortedError();
      const slot = cursor++;
      if (slot >= pending.length) return;
      const i = pending[slot];
      const start = i * CHUNK_SIZE;
      await putChunk(fileId, i, file.slice(start, Math.min(start + CHUNK_SIZE, file.size)), signal);
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
  if (failure) throw failure.reason;

  // 3. Complete
  if (signal?.aborted) throw new UploadAbortedError();
  const completeRes = await fetch(`/api/upload/complete/${fileId}`, { method: "POST", signal });
  if (!completeRes.ok) {
    const body = (await completeRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to complete chunked upload.");
  }
  const completeBody = (await completeRes.json().catch(() => ({}))) as { file?: UploadedFileMeta };

  onProgress(100);
  return { fileId, file: completeBody.file ?? null };
}
