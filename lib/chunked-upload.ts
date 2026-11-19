import { UploadAbortedError, fileFetch } from "@/lib/api-client";
import { resumeKeyFor } from "@/lib/file-identity";
import { CHUNK_SIZE, CHUNK_CONCURRENCY, MAX_HONOURED_WAIT_MS, retryAfterMs, type UploadBackend } from "@/lib/upload-config";
import { DirectUploadUnavailable, uploadDirect } from "@/lib/direct-upload";
import { readDirectReceipt, saveDirectReceipt, clearDirectReceipt, readDirectPieces, saveDirectPieces } from "@/lib/direct-receipt";
import { DIRECT_MAX_BYTES } from "@/lib/direct-parts";
import { BackupPausedError } from "@/lib/backup-network";

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

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new UploadAbortedError()); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
});

class UploadRefusedError extends Error {}

function isAbort(err: unknown) {
  return err instanceof UploadAbortedError || (err instanceof DOMException && err.name === "AbortError");
}

async function putChunk(fileId: string, index: number, blob: Blob, signal?: AbortSignal, beforeSend?: () => Promise<void>) {
  let lastErr: unknown;
  /** Set when the server names a Retry-After; overrides the jittered backoff once. */
  let waitOverride: number | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await beforeSend?.();
    if (signal?.aborted) throw new UploadAbortedError();
    try {
      const form = new FormData();
      form.append("chunk", blob);
      const res = await fileFetch(`/api/upload/chunk/${fileId}/${index}`, { method: "POST", body: form, signal });
      if (res.ok) return;

      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const err = new Error(body.error || `Chunk ${index} failed (HTTP ${res.status}).`);
      // 4xx other than 429 means this chunk will never succeed — fail fast.
      if (res.status < 500 && ![408, 425, 429].includes(res.status)) throw new UploadRefusedError(err.message);
      lastErr = err;
      // A 429 here is usually Telegram's FLOOD_WAIT relayed by lib/api-response,
      // and it carries the wait Telegram actually asked for. Backing off by our
      // own guess instead means retrying into the same flood and extending it —
      // Telegram lengthens the wait each time it is ignored. So when the server
      // names a delay, that delay wins over the jittered schedule below.
      if (res.status === 429) {
        const named = retryAfterMs(res.headers.get("retry-after"));
        if (named !== null) {
          waitOverride = named;
          // A long FLOOD_WAIT is measured in hours. Sleeping through it holds a
          // worker hostage and looks identical to a hang, so surface it instead
          // and let the queue move to the next file; Resume picks this one up.
          if (named > MAX_HONOURED_WAIT_MS) {
            throw new UploadRefusedError(
              `Telegram is rate-limiting this account for ${Math.ceil(named / 60_000)} more minutes. ` +
                `This upload is paused — retry it after that.`
            );
          }
        }
      }
    } catch (err) {
      if (isAbort(err)) throw new UploadAbortedError();
      if (err instanceof UploadRefusedError || err instanceof BackupPausedError) throw err;
      lastErr = err;
    }
    if (attempt < MAX_RETRIES - 1) await sleep(waitOverride ?? retryDelay(attempt), signal);
    waitOverride = null;
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Chunk ${index} failed.`);
}

/** The server refused because this file is already stored in that folder. */
export class DuplicateFileError extends Error {
  readonly existing: { id: string; name: string };
  constructor(existing: { id: string; name: string }) {
    super(`"${existing.name}" is already in this folder.`);
    this.existing = existing;
    this.name = "DuplicateFileError";
  }
}

/**
 * A file bigger than one Telegram message (2,000 MiB), sent as several:
 * "name.001", "name.002", … — the usual split naming, so a piece forwarded on
 * its own can still be joined by 7-Zip or `copy /b`. Each finished piece is
 * remembered, so a reload or retry carries on from the next one. There is no
 * relay fallback: the relay stores one message, which cannot hold this file.
 */
async function uploadSplit({ file, user, fileId, onProgress, signal, beforeSend }: {
  file: File;
  user: string;
  fileId: string;
  onProgress: (loadedBytes: number) => void;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
}): Promise<{ fileId: string; file: UploadedFileMeta | null }> {
  const count = Math.ceil(file.size / DIRECT_MAX_BYTES);
  const pad = String(count).length > 3 ? String(count).length : 3;
  const ids = readDirectPieces(user, fileId).slice(0, count);
  try {
    for (let index = ids.length; index < count; index++) {
      const start = index * DIRECT_MAX_BYTES;
      const piece = new File([file.slice(start, Math.min(start + DIRECT_MAX_BYTES, file.size))],
        `${file.name}.${String(index + 1).padStart(pad, "0")}`, { type: "application/octet-stream" });
      const { messageId } = await uploadDirect({
        user,
        file: piece,
        caption: `\u{1F4C4} ${file.name} (part ${index + 1} of ${count})`,
        onProgress: loaded => onProgress(Math.min(start + loaded, file.size - 1)),
        signal,
        beforeSend
      });
      ids.push(messageId);
      saveDirectPieces(user, fileId, ids);
    }
    const res = await fileFetch(`/api/upload/direct/${fileId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIds: ids }),
      signal
    });
    const body = (await res.json().catch(() => ({}))) as { file?: UploadedFileMeta; error?: string };
    if (!res.ok || !body.file?.id) throw new Error(body.error || "Telegram stored the file, but the drive could not confirm it. Retry to confirm.");
    clearDirectReceipt(user, fileId);
    onProgress(file.size);
    return { fileId, file: body.file };
  } catch (err) {
    if (err instanceof BackupPausedError) throw err;
    if (isAbort(err)) throw new UploadAbortedError();
    throw new DirectUploadUnavailable(`${(err as Error)?.message || "Upload failed."} Finished parts are kept; retry to continue.`);
  }
}

export async function uploadFileInChunks({
  file,
  user,
  directOnly = false,
  beforeSend,
  folderId,
  prefer,
  contentHash,
  allowDuplicate,
  onProgress,
  signal,
}: {
  file: File;
  /** Which TeleDrive account this is, so the direct path can find the Telegram
   *  session *this browser* authorised for them. */
  user: string;
  directOnly?: boolean;
  beforeSend?: () => Promise<void>;
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
  // Direct mode needs only a metadata row here, not the relay's chunk settings.
  const initRes = await (directOnly ? fetch : fileFetch)("/api/upload/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      folderId,
      prefer: directOnly ? "account" : prefer,
      contentHash,
      allowDuplicate,
      resumeKey: (directOnly ? "direct|" : "") + resumeKeyFor(file),
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
    chunkSizeBytes,
    backend
  } = (await initRes.json()) as {
    fileId: string;
    totalChunks: number;
    received?: number[];
    chunkSizeBytes?: number;
    backend?: UploadBackend;
  };

  if (directOnly && (backend !== "mtproto" || received.length > 0)) {
    throw new DirectUploadUnavailable("This upload cannot use direct mode. Link your Telegram account in Settings first. No file bytes were relayed.");
  }
  if (backend === "mtproto" && received.length === 0 && file.size > DIRECT_MAX_BYTES) {
    return uploadSplit({ file, user, fileId, onProgress, signal, beforeSend });
  }
  if (backend === "mtproto" && received.length === 0) {
    try {
      let messageId = readDirectReceipt(user, fileId);
      if (messageId === null) {
        ({ messageId } = await uploadDirect({
          user,
          file,
          caption: "\u{1F4C4} " + file.name,
          onProgress,
          signal,
          beforeSend
        }));
        saveDirectReceipt(user, fileId, messageId);
      }
      const res = await fileFetch(`/api/upload/direct/${fileId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId }),
        signal
      });
      if (res.ok) {
        const done = (await res.json()) as { file?: UploadedFileMeta };
        if (!done.file?.id) throw new Error("Telegram stored the file, but confirmation was incomplete. Retry to confirm without re-uploading.");
        clearDirectReceipt(user, fileId);
        onProgress(file.size);
        return { fileId, file: done.file ?? null };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || "Telegram stored the file, but the drive could not confirm it. Retry to confirm.");
    } catch (err) {
      if (err instanceof BackupPausedError) throw err;
      if (isAbort(err)) throw new UploadAbortedError();
      if (directOnly || readDirectReceipt(user, fileId) !== null) {
        throw new DirectUploadUnavailable(`${(err as Error)?.message || "Direct upload failed."} No file bytes were relayed. Retry when connected.`);
      }
      if (!(err instanceof DirectUploadUnavailable)) {
        console.warn("[upload] direct upload failed, relaying instead:", (err as Error)?.message);
      }
      // Reset the bar: whatever direct managed is not credited to the relay.
      onProgress(0);
    }
  }

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
      await putChunk(fileId, i, file.slice(start, Math.min(start + chunkSize, file.size)), signal, beforeSend);
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
    // Keep confirmed chunks on every failure. A retry can resume them; expired
    // sessions are cleaned up server-side. Network errors must not erase progress.
    throw failure.reason;
  }

  // 3. Complete
  if (signal?.aborted) throw new UploadAbortedError();
  const completeRes = await fileFetch(`/api/upload/complete/${fileId}`, { method: "POST", signal });
  if (!completeRes.ok) {
    const body = (await completeRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to complete chunked upload.");
  }
  const completeBody = (await completeRes.json().catch(() => ({}))) as { file?: UploadedFileMeta };
  if (!completeBody.file?.id) throw new Error("Upload confirmation was incomplete. Retry to check the saved file.");

  onProgress(file.size);
  return { fileId, file: completeBody.file ?? null };
}
