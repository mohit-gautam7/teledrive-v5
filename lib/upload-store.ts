/**
 * Upload sessions that survive a page reload.
 *
 * The server already keeps an interrupted upload resumable for a day — a session
 * is looked up by `resumeKey` and answers with the chunk indexes it already
 * holds (see /api/upload/init). What was missing was the browser half: closing
 * or refreshing the tab dropped the queue entirely, so the bytes were still on
 * Telegram but nothing knew to carry on.
 *
 * Two things are persisted, because neither alone is enough:
 *
 *  - The *description* of each queued upload (localStorage). Small, universally
 *    available, and enough to show the transfer panel again and ask the server
 *    what is still missing.
 *  - The *file handle*, where the browser has one (IndexedDB). A `File` cannot
 *    be persisted — the page reloads and the bytes are gone — but Chromium hands
 *    out a `FileSystemFileHandle` for dropped files, and that is storable. With
 *    it the upload resumes on its own; without it the panel offers a one-click
 *    "Resume" that re-picks the same file. Either way only the missing chunks
 *    are sent, never the whole file again.
 */

export type PersistedUpload = {
  id: string;
  /** Server session id, once /api/upload/init has answered. */
  fileId: string | null;
  name: string;
  size: number;
  lastModified: number;
  folderId: string | null;
  resumeKey: string;
  path?: string;
  /** Bytes confirmed stored when the page went away, for a sensible first paint. */
  loaded: number;
  updatedAt: number;
};

const STORE_VERSION = 1;
/** Matches the server's stale-session sweep; past this there is nothing to resume. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function storeKey(user: string) {
  return `td:${user}:uploads:v${STORE_VERSION}`;
}

export function readPersisted(user: string): PersistedUpload[] {
  try {
    const raw = window.localStorage.getItem(storeKey(user));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedUpload[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter(item => item && typeof item.resumeKey === "string" && item.updatedAt > cutoff);
  } catch {
    return [];
  }
}

export function writePersisted(user: string, items: PersistedUpload[]) {
  try {
    if (!items.length) window.localStorage.removeItem(storeKey(user));
    else window.localStorage.setItem(storeKey(user), JSON.stringify(items));
  } catch {
    /* quota — persistence is an optimisation, never a requirement */
  }
}

// ── File handles ─────────────────────────────────────────────────────────────

export type StoredFileHandle = FileSystemFileHandle & {
  queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
};

const DB_NAME = "teledrive-uploads";
const STORE = "handles";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked upgrade would hang the promise and with it the whole mount.
    request.onblocked = () => resolve(null);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    db =>
      new Promise<T | null>(resolve => {
        if (!db) return resolve(null);
        try {
          const request = run(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

export function rememberHandle(resumeKey: string, handle: StoredFileHandle) {
  return tx("readwrite", store => store.put(handle, resumeKey) as IDBRequest<unknown>);
}

export function recallHandle(resumeKey: string) {
  return tx<StoredFileHandle>("readonly", store => store.get(resumeKey) as IDBRequest<StoredFileHandle>);
}

export function forgetHandle(resumeKey: string) {
  return tx("readwrite", store => store.delete(resumeKey) as IDBRequest<undefined>);
}

/**
 * The file behind a stored handle, if it can be read without asking.
 *
 * `queryPermission` is the whole point: a handle whose permission has lapsed
 * needs a user gesture to re-grant, and calling `requestPermission` outside one
 * throws. So a silent resume is attempted only when permission is already
 * granted, and the panel's Resume button covers every other case.
 */
export async function fileFromHandle(handle: StoredFileHandle, options: { prompt: boolean }): Promise<File | null> {
  try {
    const state = (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state !== "granted") {
      if (!options.prompt) return null;
      const granted = (await handle.requestPermission?.({ mode: "read" })) ?? "denied";
      if (granted !== "granted") return null;
    }
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** A dropped item's handle, on browsers that expose one. */
export async function handleFromDataTransferItem(item: DataTransferItem): Promise<StoredFileHandle | null> {
  const get = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
    .getAsFileSystemHandle;
  if (typeof get !== "function") return null;
  try {
    const handle = await get.call(item);
    return handle && handle.kind === "file" ? (handle as StoredFileHandle) : null;
  } catch {
    return null;
  }
}

/** True when the picked file is byte-for-byte the one a session was started for. */
export function matchesSession(file: File, session: PersistedUpload) {
  return file.name === session.name && file.size === session.size && file.lastModified === session.lastModified;
}
