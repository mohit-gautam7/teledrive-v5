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

type Sink = { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type NativeSave = {
  saveBegin(o: { name: string; mimeType: string }): Promise<{ id: string }>;
  saveWrite(o: { id: string; data: string }): Promise<unknown>;
  saveEnd(o: { id: string }): Promise<{ path: string }>;
  saveAbort(o: { id: string }): Promise<unknown>;
};

function nativeSave(): NativeSave | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { Capacitor?: { Plugins?: { Backup?: Partial<NativeSave> } } }).Capacitor?.Plugins?.Backup;
  return api?.saveBegin ? (api as NativeSave) : null;
}

function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The Android app's WebView drops link and blob downloads, and its save
 * picker exists but cannot open, so there the app writes the file natively
 * into Downloads. Pieces are batched to ~1 MiB per bridge call.
 */
async function openNativeSink(api: NativeSave, filename: string): Promise<Sink> {
  const { id } = await api.saveBegin({ name: filename, mimeType: "" });
  let pending: Uint8Array[] = [];
  let size = 0;
  const flush = async () => {
    if (!size) return;
    const joined = new Uint8Array(size);
    let at = 0;
    for (const part of pending) { joined.set(part, at); at += part.byteLength; }
    pending = []; size = 0;
    await api.saveWrite({ id, data: base64(joined) });
  };
  return {
    async write(chunk) { pending.push(chunk); size += chunk.byteLength; if (size >= 1024 * 1024) await flush(); },
    async close() { await flush(); await api.saveEnd({ id }); },
    async abort() { await api.saveAbort({ id }).catch(() => {}); }
  };
}

export function canStreamToDisk() {
  if (nativeSave()) return true;
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
  onProgress,
  direct,
  source
}: {
  url: string;
  filename: string;
  /** Known size, so a server that omits Content-Length still yields a percentage. */
  sizeHint?: number;
  /** Method/body for endpoints that take a selection, such as the zip builder. */
  init?: Pick<RequestInit, "method" | "body" | "headers">;
  signal?: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
  /** Read from Telegram in this browser instead of the file server, when the
   *  file is in the user's own account and this browser is connected. */
  direct?: { user: string; messageId: number | number[] };
  /** Bytes produced on this device (a zip it builds), instead of a request. */
  source?: () => ReadableStream<Uint8Array>;
}): Promise<DownloadOutcome> {
  const streaming = canStreamToDisk();

  // Ask where to put it *before* the request starts: the picker needs the user
  // gesture that triggered the download, and a request in flight would expire it.
  let writable: Sink | null = null;
  const native = nativeSave();
  if (native) {
    try {
      writable = await openNativeSink(native, filename);
    } catch (error) {
      throw new Error(`Could not save to Downloads: ${(error as Error)?.message || "update the app"}`);
    }
  } else if (streaming) {
    try {
      const handle = await (window as PickerWindow).showSaveFilePicker!({ suggestedName: filename });
      const file = await handle.createWritable();
      writable = {
        write: chunk => file.write(chunk as Uint8Array<ArrayBuffer>),
        close: () => file.close(),
        abort: () => file.abort()
      };
    } catch {
      // Dismissed picker means "don't download", not "download some other way".
      return "cancelled";
    }
  } else if ((sizeHint ?? 0) > MEMORY_DOWNLOAD_LIMIT && !init && !source) {
    // A POST cannot be handed to the browser as a link, so an archive never
    // takes this path; the caller checks the selection against the same limit
    // before starting one.
    browserDownload(url);
    return "handed-to-browser";
  }

  try {
    const parts: Uint8Array[] = [];
    let loaded = 0;
    const collect = async (chunk: Uint8Array, total: number) => {
      if (writable) await writable.write(chunk);
      else parts.push(chunk);
      loaded += chunk.byteLength;
      onProgress({ loaded, total });
    };

    let viaTelegram = false;
    if (direct) {
      const { browserLinked, downloadDirect } = await import("@/lib/direct-upload");
      if (browserLinked(direct.user)) {
        try {
          for await (const chunk of downloadDirect(direct.user, direct.messageId, signal)) await collect(chunk, sizeHint ?? 0);
          viaTelegram = true;
        } catch (error) {
          // Nothing written yet: the file server can still deliver it. Part-way
          // through, a restart would duplicate bytes in the open file.
          if (loaded > 0 || signal?.aborted) throw error;
          console.warn("[download] direct read failed, using the file server:", (error as Error)?.message);
        }
      }
    }

    if (source) {
      const reader = source().getReader();
      for (;;) {
        if (signal?.aborted) { await reader.cancel().catch(() => {}); throw new DOMException("Aborted", "AbortError"); }
        const { done, value } = await reader.read();
        if (done) break;
        await collect(value, sizeHint ?? 0);
      }
    } else if (!viaTelegram) {
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await collect(value, total);
      }
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
