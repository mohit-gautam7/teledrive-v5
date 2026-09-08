/**
 * Downloads with real progress.
 *
 * `location.href = "/api/download/…"` hands the transfer to the browser, which
 * means the app cannot see a single byte of it — no percentage, no speed, no
 * ETA, and no way to show it next to the uploads. So the bytes are pulled by the
 * app instead, and where they are put depends on what the browser can do:
 *
 *  - `showSaveFilePicker` (Chromium): piped straight to the chosen file. Any
 *    size, constant memory, cancellable.
 *  - Otherwise: collected in memory and saved as a blob at the end, which is
 *    fine for ordinary files and refused for very large ones — buffering a 2 GB
 *    video would take the tab down with it.
 *  - Too large with no picker: handed back to the browser, which downloads it
 *    perfectly well; the panel then says so rather than inventing a percentage.
 */

import { apiUrl, assetUrl, fileAuthHeaders } from "@/lib/file-origin";

/** Above this, an in-memory download is a tab crash waiting to happen. */
export const MEMORY_DOWNLOAD_LIMIT = 512 * 1024 * 1024;

export type DownloadProgress = {
  loaded: number;
  /** Total from Content-Length, or the caller's hint when the server sent none. */
  total: number;
};

export type DownloadOutcome = "saved" | "handed-to-browser" | "cancelled";

type SaveFilePickerOptions = {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
};

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
};

export function canStreamToDisk() {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showSaveFilePicker === "function";
}

/**
 * Hand the transfer back to the browser — always works, just unobservable.
 *
 * `assetUrl` rather than `apiUrl`: the browser makes this request itself, so
 * there is no header to put a token in and it has to travel in the query string.
 * Same-origin, both return the path untouched.
 */
export function browserDownload(url: string) {
  const anchor = document.createElement("a");
  anchor.href = assetUrl(url);
  anchor.download = "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadWithProgress({
  url,
  filename,
  sizeHint,
  init,
  signal,
  onProgress
}: {
  url: string;
  filename: string;
  /** Known size, so a server that omits Content-Length still yields a percentage. */
  sizeHint?: number;
  /** Method/body for endpoints that take a selection, such as the zip builder. */
  init?: Pick<RequestInit, "method" | "body" | "headers">;
  signal?: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<DownloadOutcome> {
  const streaming = canStreamToDisk();

  // Ask where to put it *before* the request starts: the picker needs the user
  // gesture that triggered the download, and a request in flight would expire it.
  let writable: FileSystemWritableFileStream | null = null;
  if (streaming) {
    try {
      const handle = await (window as PickerWindow).showSaveFilePicker!({ suggestedName: filename });
      writable = await handle.createWritable();
    } catch {
      // Dismissed picker means "don't download", not "download some other way".
      return "cancelled";
    }
  } else if ((sizeHint ?? 0) > MEMORY_DOWNLOAD_LIMIT && !init) {
    // A POST cannot be handed to the browser as a link, so an archive never
    // takes this path; the caller checks the selection against the same limit
    // before starting one.
    browserDownload(url);
    return "handed-to-browser";
  }

  try {
    const target = apiUrl(url);
    const auth = target === url ? {} : await fileAuthHeaders();
    const response = await fetch(target, {
      ...init,
      signal,
      headers: { ...((init?.headers as Record<string, string>) ?? {}), ...auth }
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Download failed (HTTP ${response.status}).`);
    }

    const declared = Number(response.headers.get("content-length")) || 0;
    const total = declared || sizeHint || 0;
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let loaded = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writable) await writable.write(value);
      else parts.push(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }

    if (writable) {
      await writable.close();
      writable = null;
      return "saved";
    }

    const blobUrl = URL.createObjectURL(new Blob(parts as BlobPart[]));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked late: revoking immediately races the browser's own read of it.
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return "saved";
  } catch (error) {
    // A partially written file is worse than none — the user would find a
    // truncated video on disk with no sign anything went wrong.
    if (writable) await writable.abort().catch(() => {});
    if (signal?.aborted) return "cancelled";
    throw error;
  }
}
