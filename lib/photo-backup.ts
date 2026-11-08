/**
 * Camera-roll backup from the browser.
 *
 * The received wisdom is that only a native app can do this. That stopped
 * being true: `showDirectoryPicker()` reached Chrome on Android in 132, and
 * a directory handle survives in IndexedDB with its permission intact, so an
 * installed PWA can be pointed at DCIM once and re-read it afterwards without
 * asking again.
 *
 * What that buys, honestly:
 *
 *  - Android Chrome 132+ (and Samsung Internet 29+). Firefox and every
 *    browser on iOS have no File System Access API at all, and no plans to.
 *    On those, backup is the share sheet or nothing.
 *  - It runs when you open the app, and not before. Periodic Background Sync
 *    exists and Chrome supports it, but it wakes a *service worker*, and the
 *    upload queue — with its resume, concurrency and duplicate handling —
 *    lives in the page. Waking a worker that cannot upload anything would be
 *    a permission prompt in exchange for nothing, so it is not registered.
 *    This is not the instant on-shutter upload Google Photos does; nothing
 *    on the web is.
 *
 * Deliberately almost no new machinery: the directory handle store, the tree
 * walk, the upload queue and the server-side duplicate check all already exist
 * for folder uploads. This module is the watermark and the plumbing between
 * them.
 */

import { filesFromDirectoryHandle, type PickedFile } from "@/components/drive/dnd";
import { recallHandle, rememberHandle, type StoredDirectoryHandle } from "@/lib/upload-store";

/** One remembered source folder per browser profile. */
export const BACKUP_SOURCE_KEY = "dir:__backup_source__";

export type BackupState = {
  enabled: boolean;
  /** Display name of the chosen folder, for the settings card. */
  folderName: string | null;
  /** Highest `lastModified` already queued. Everything newer is unseen. */
  watermark: number;
  lastRunAt: number;
  lastCount: number;
};

const EMPTY: BackupState = { enabled: false, folderName: null, watermark: 0, lastRunAt: 0, lastCount: 0 };

// `td:` so sign-out clears it along with the rest of this account's state.
const stateKey = (user: string) => `td:${user}:backup:v1`;

export function readBackupState(user: string): BackupState {
  try {
    const raw = window.localStorage.getItem(stateKey(user));
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<BackupState>) };
  } catch {
    return { ...EMPTY };
  }
}

export function writeBackupState(user: string, patch: Partial<BackupState>): BackupState {
  const next = { ...readBackupState(user), ...patch };
  try {
    window.localStorage.setItem(stateKey(user), JSON.stringify(next));
  } catch {
    /* private mode, quota — the feature degrades to "re-pick each time" */
  }
  return next;
}

/**
 * Whether this browser can do it at all. Checked before the settings card
 * renders, because offering a button that cannot work is worse than saying
 * plainly that the browser does not support it.
 */
export function backupSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

type PickerWindow = Window & {
  showDirectoryPicker: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<StoredDirectoryHandle>;
};

/**
 * Ask once for the folder to watch. Must be called from a user gesture.
 * Returns the folder's name, or null if the picker was dismissed.
 */
export async function chooseSource(user: string): Promise<string | null> {
  if (!backupSupported()) return null;
  let handle: StoredDirectoryHandle;
  try {
    // `startIn: "pictures"` opens on the camera roll on Android rather than at
    // the root of storage. `id` makes Chrome reopen in the same place next time.
    handle = await (window as unknown as PickerWindow).showDirectoryPicker({
      id: "teledrive-backup",
      mode: "read",
      startIn: "pictures"
    });
  } catch {
    return null; // dismissed — not an error worth a toast
  }
  await rememberHandle(BACKUP_SOURCE_KEY, handle);
  writeBackupState(user, { folderName: handle.name, enabled: true });
  return handle.name;
}

export type ScanResult =
  | { ok: true; files: PickedFile[]; newest: number }
  | { ok: false; reason: "unsupported" | "no-folder" | "needs-permission" | "failed"; detail?: string };

/**
 * Everything in the watched folder modified since the last run.
 *
 * `prompt: false` is the background path — it never shows a permission dialog,
 * because there is no user gesture to attach one to, and reports
 * "needs-permission" so the UI can offer a button instead.
 */
export async function scanForNew(user: string, options: { prompt: boolean }): Promise<ScanResult> {
  if (!backupSupported()) return { ok: false, reason: "unsupported" };

  const handle = (await recallHandle(BACKUP_SOURCE_KEY)) as StoredDirectoryHandle | null;
  if (!handle) return { ok: false, reason: "no-folder" };

  try {
    let permission = await handle.queryPermission?.({ mode: "read" });
    if (permission !== "granted" && options.prompt) {
      permission = await handle.requestPermission?.({ mode: "read" });
    }
    if (permission !== "granted") return { ok: false, reason: "needs-permission" };
  } catch {
    return { ok: false, reason: "needs-permission" };
  }

  try {
    const { watermark } = readBackupState(user);
    const all = await filesFromDirectoryHandle(handle);

    // `lastModified` is the only cheap signal a directory walk gives. It misses
    // a file copied in with an old timestamp — "Back up everything" resets the
    // watermark for exactly that case. It never *re-sends* anything either way:
    // /api/upload/check fingerprints each file against the drive first.
    const files = all.filter(p => p.file.lastModified > watermark && p.file.size > 0);
    const newest = all.reduce((max, p) => Math.max(max, p.file.lastModified), watermark);
    return { ok: true, files, newest };
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Record that everything up to `newest` has been handed to the queue. */
export function markScanned(user: string, newest: number, count: number): void {
  writeBackupState(user, { watermark: newest, lastRunAt: Date.now(), lastCount: count });
}

/** Re-check the whole folder next time, for files with misleading timestamps. */
export function resetWatermark(user: string): void {
  writeBackupState(user, { watermark: 0 });
}
