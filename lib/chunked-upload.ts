import { UploadAbortedError } from "@/lib/api-client";
import { CHUNK_SIZE } from "@/lib/upload-config";

const MAX_RETRIES = 5;
const RETRY_DELAYS = [2000, 4000, 8000, 16000, 30000]; // ms — gives network time to recover

export type UploadedFileMeta = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageMode: "BOT" | "PERSONAL";
  folderId: string | null;
  isFavorite: boolean;
  createdAt: string;
};

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

  // 1. Init
  const initRes = await fetch("/api/upload/init", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size, folderId }),
    signal,
  });
  if (!initRes.ok) {
    const body = await initRes.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Failed to initialise chunked upload.");
  }
  const { fileId, totalChunks } = await initRes.json() as { fileId: string; totalChunks: number };

  // 2. Upload each chunk sequentially with retry + exponential backoff
  for (let i = 0; i < totalChunks; i++) {
    if (signal?.aborted) throw new UploadAbortedError();

    const start = i * CHUNK_SIZE;
    const end   = Math.min(start + CHUNK_SIZE, file.size);
    const blob  = file.slice(start, end);

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new UploadAbortedError();
      try {
        const form = new FormData();
        form.append("chunk", blob);
        const res = await fetch(`/api/upload/chunk/${fileId}/${i}`, { method: "POST", body: form, signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error || `Chunk ${i} upload failed (HTTP ${res.status}).`);
        }
        lastErr = null;
        break;
      } catch (err) {
        if (err instanceof UploadAbortedError || (err instanceof DOMException && err.name === "AbortError")) {
          throw new UploadAbortedError();
        }
        lastErr = err;
        if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
    if (lastErr) throw lastErr;

    onProgress(Math.round(((i + 1) / totalChunks) * 95));
  }

  // 3. Complete
  if (signal?.aborted) throw new UploadAbortedError();
  const completeRes = await fetch(`/api/upload/complete/${fileId}`, { method: "POST", signal });
  if (!completeRes.ok) {
    const body = await completeRes.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Failed to complete chunked upload.");
  }
  const completeBody = await completeRes.json().catch(() => ({})) as { file?: UploadedFileMeta };

  onProgress(100);
  return { fileId, file: completeBody.file ?? null };
}
