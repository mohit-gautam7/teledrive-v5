"use client";

import { toast } from "sonner";
import { ApiError, UploadAbortedError, fileFetch, uploadFile } from "@/lib/api-client";
import { DuplicateFileError, uploadFileInChunks } from "@/lib/chunked-upload";
import { resumeKeyFor } from "@/lib/file-identity";
import type { QueuedUpload, SkippedUpload } from "@/lib/duplicate-plan";
import { SINGLE_SHOT_LIMIT } from "@/lib/upload-config";
import { readPreferences } from "@/lib/preferences";
import { canThumbnail, makeThumbnail } from "@/lib/thumbnail";
import {
  fileFromHandle,
  forgetHandle,
  matchesSession,
  readPersisted,
  recallFromDirectory,
  recallHandle,
  writePersisted,
  type PersistedUpload
} from "@/lib/upload-store";
import { sampleRate, type DriveFile, type UploadItem } from "@/components/drive/types";

/**
 * The upload queue, owned by the module rather than by a component.
 *
 * It used to live in `DriveApp`'s state, which tied every upload to that one
 * mount: leaving /drive for a share page, or any route change that unmounted the
 * tree, aborted whatever was in flight. Nothing about sending bytes to Telegram
 * needs a React tree, so the queue, its workers and its persistence live here,
 * and components subscribe to it through `useSyncExternalStore`.
 *
 * What a browser genuinely cannot do is outlive its tab. There is no worker or
 * service-worker trick that keeps a `File` streaming after the page is closed —
 * the handle to the bytes dies with the document. So the promise this makes is
 * the honest one: an upload survives navigation *within* the app, and survives a
 * reload or a close by pausing and resuming from the chunks the server already
 * holds. The transfer panel says exactly that rather than implying more.
 */

type Hooks = {
  /** A file finished storing — the drive listing can show it now. */
  onStored?: (file: DriveFile) => void;
  /** A replaced file was moved to Trash — drop it from the listing. */
  onRemoved?: (fileId: string) => void;
  /** The queue went quiet; a good moment to refresh totals. */
  onIdle?: () => void;
};

type Listener = () => void;

/**
 * How many files may be in flight, read fresh on every pump.
 *
 * It was a hard 1. That is the safe number for a handful of large files and the
 * wrong one for the case this queue exists to serve — a folder of several
 * hundred small ones, where each file costs an init, a complete and a thumbnail
 * round-trip that nothing overlaps.
 *
 * Read per pump rather than captured once so that changing the setting takes
 * effect on the running queue: lowering it lets the extra workers drain and stop,
 * raising it starts more on the next completion. Neither disturbs an upload
 * already sending bytes.
 */
function maxParallel() {
  return readPreferences().uploadConcurrency;
}

/** Trailing delay on writing the queue to localStorage. Progress ticks arrive
 *  dozens of times a second and each one used to mean a synchronous
 *  `localStorage.setItem` over the whole queue. */
const PERSIST_DEBOUNCE_MS = 2000;

class UploadManager {
  private items: UploadItem[] = EMPTY;
  private listeners = new Set<Listener>();
  private controllers = new Map<string, AbortController>();
  private samples = new Map<string, Array<{ t: number; loaded: number }>>();
  private hooks: Hooks = {};
  private running = 0;
  private pausedGlobally = false;
  private user = "anon";
  private hydrated = false;
  private persistTimer: number | null = null;
  private emitFrame: number | null = null;
  /** Cached so `getSnapshot` is referentially stable between real changes —
   *  useSyncExternalStore re-renders forever otherwise. */
  private snapshot: UploadItem[] = EMPTY;

  // ── Subscription ──────────────────────────────────────────────────────────

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** The server renders no transfers, so one frozen empty array is the answer. */
  getServerSnapshot = () => EMPTY;

  private emit() {
    if (this.emitFrame !== null) {
      cancelAnimationFrame(this.emitFrame);
      this.emitFrame = null;
    }
    this.snapshot = this.items;
    for (const listener of this.listeners) listener();
  }

  /**
   * Publish at most once per frame.
   *
   * Progress arrives far faster than anyone can read it, and every notification
   * re-renders the drive. requestAnimationFrame collapses a burst into one paint
   * and — because browsers stop running it in a hidden tab — costs nothing at all
   * while the upload runs in the background, which is exactly when it should.
   * State changes still call `emit` directly, so nothing final waits on a frame.
   */
  private emitSoon() {
    if (typeof requestAnimationFrame !== "function") {
      this.emit();
      return;
    }
    if (this.emitFrame !== null) return;
    this.emitFrame = requestAnimationFrame(() => {
      this.emitFrame = null;
      this.snapshot = this.items;
      for (const listener of this.listeners) listener();
    });
  }

  private assign(id: string, changes: Partial<UploadItem>) {
    this.items = this.items.map(it => (it.id === id ? { ...it, ...changes } : it));
  }

  private patch(id: string, changes: Partial<UploadItem>) {
    this.assign(id, changes);
    this.emit();
    this.persist();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  setHooks(hooks: Hooks) {
    this.hooks = hooks;
  }

  /** Everything in flight or waiting — drives the "leaving will pause it" prompt. */
  get busy() {
    return this.items.some(it => it.status === "uploading" || it.status === "pending");
  }

  get anyPaused() {
    return this.items.some(it => it.status === "paused");
  }

  // ── Queueing ──────────────────────────────────────────────────────────────

  add(picked: QueuedUpload[], skipped: SkippedUpload[] = []) {
    const items: UploadItem[] = [
      ...skipped.map<UploadItem>(entry => ({
        id: Math.random().toString(36).slice(2),
        name: entry.name,
        size: entry.size,
        loaded: entry.size,
        percent: 100,
        speed: null,
        eta: null,
        status: "skipped",
        file: null,
        duplicateOf: entry.duplicateOf
      })),
      ...picked.map<UploadItem>(({ file, path, destination, contentHash, allowDuplicate, replaceFileId }) => ({
        id: Math.random().toString(36).slice(2),
        name: file.name,
        size: file.size,
        loaded: 0,
        percent: 0,
        speed: null,
        eta: null,
        status: "pending",
        file,
        lastModified: file.lastModified,
        folderId: destination,
        resumeKey: resumeKeyFor(file),
        path,
        contentHash,
        allowDuplicate,
        replaceFileId
      }))
    ];
    // Appended, not assigned: a session restored from a previous visit is
    // waiting in this queue, and replacing it would strand chunks the server is
    // still holding.
    this.items = [...this.items.filter(it => it.status !== "done" && it.status !== "skipped"), ...items];
    // Adding work is an explicit act, so it lifts a global pause rather than
    // silently landing in a queue that will not move.
    this.pausedGlobally = false;
    this.emit();
    this.persist();
    void this.pump();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  /**
   * Stop this upload where it stands, keeping it resumable.
   *
   * The status is set *before* the abort so the worker, which sees the
   * `UploadAbortedError` a moment later, can tell a pause from a cancel. The
   * server session is deliberately left alone: /api/upload/init hands back the
   * chunks it already holds, which is what makes resuming cheap.
   */
  pause(id: string) {
    const item = this.items.find(it => it.id === id);
    if (!item || item.status === "done" || item.status === "paused") return;
    this.patch(id, { status: "paused", speed: null, eta: null });
    this.samples.delete(id);
    this.controllers.get(id)?.abort();
  }

  pauseAll() {
    this.pausedGlobally = true;
    for (const item of this.items) {
      if (item.status === "uploading" || item.status === "pending") this.pause(item.id);
    }
  }

  resume(id: string) {
    const item = this.items.find(it => it.id === id);
    if (!item || item.status === "uploading" || item.status === "skipped") return;
    this.pausedGlobally = false;
    if (!item.file) {
      // No bytes in this tab. A Resume click is a real user gesture, which is the
      // one moment `requestPermission` on a stored handle is legal — so ask for
      // the handle back before falling back to a file dialog.
      void this.reattach(item);
      return;
    }
    this.patch(id, { status: "pending", error: undefined });
    void this.pump();
  }

  resumeAll() {
    this.pausedGlobally = false;
    for (const item of this.items) {
      if ((item.status === "paused" || item.status === "error") && item.file) {
        this.patch(item.id, { status: "pending", error: undefined });
      }
    }
    void this.pump();
  }

  retry(id: string) {
    this.resume(id);
  }

  /** Give up on this upload for good: the session is abandoned and swept later. */
  cancel(id: string) {
    const item = this.items.find(it => it.id === id);
    this.items = this.items.filter(it => it.id !== id);
    this.emit();
    this.persist();
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.samples.delete(id);
    if (item?.resumeKey) void forgetHandle(item.resumeKey);
  }

  cancelAll() {
    const doomed = this.items.filter(it => it.status !== "done");
    this.items = this.items.filter(it => it.status === "done");
    this.emit();
    this.persist();
    for (const item of doomed) {
      this.controllers.get(item.id)?.abort();
      this.controllers.delete(item.id);
      this.samples.delete(item.id);
      if (item.resumeKey) void forgetHandle(item.resumeKey);
    }
  }

  /** Remove a finished or failed row from the panel without touching Telegram. */
  dismiss(id: string) {
    this.items = this.items.filter(it => it.id !== id);
    this.emit();
    this.persist();
  }

  /** Finished rows tidy themselves away. Skipped ones stay: "12 files were
   *  already here" is the answer to what just happened, and it should still be
   *  on screen a moment later. */
  clearFinished() {
    if (!this.items.some(it => it.status === "done")) return;
    this.items = this.items.filter(it => it.status !== "done");
    this.emit();
  }

  /** Hand the bytes back to a restored session and carry on. */
  attach(id: string, file: File) {
    const item = this.items.find(it => it.id === id);
    if (!item) return;
    this.patch(id, { file, status: "pending", error: undefined });
    void this.pump();
  }

  // ── The worker ────────────────────────────────────────────────────────────

  private async pump() {
    if (this.pausedGlobally) return;
    const limit = maxParallel();
    while (this.running < limit) {
      const next = this.items.find(it => it.status === "pending" && it.file);
      if (!next) break;
      this.running++;
      void this.run(next).finally(() => {
        this.running--;
        if (!this.busy) {
          this.hooks.onIdle?.();
          // Finished rows clear themselves after a beat; a paused session from
          // an earlier visit stays until it is resumed or dismissed.
          window.setTimeout(() => this.clearFinished(), 2500);
        }
        void this.pump();
      });
    }
  }

  private async run(item: UploadItem) {
    const source = item.file;
    if (!source) return;

    // The destination was resolved before this item was ever queued, so nothing
    // here creates folders. It used to, and re-running it on a resume nested the
    // dropped tree inside itself and changed the resume key, which abandoned
    // every chunk the server was holding and restarted the file from zero.
    const target = item.folderId ?? null;

    this.samples.delete(item.id);
    this.patch(item.id, {
      status: "uploading",
      // Not reset to 0: a resumed session starts from whatever the server
      // already holds, and zeroing it would make a 90%-done upload appear to
      // start again.
      loaded: item.status === "paused" ? item.loaded : 0,
      percent: item.status === "paused" ? item.percent : 0,
      error: undefined
    });

    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    try {
      let created: DriveFile | null = null;
      if (source.size > SINGLE_SHOT_LIMIT) {
        const result = await uploadFileInChunks({
          file: source,
          folderId: target,
          // Read at send time, not at queue time, so changing the setting takes
          // effect on the next file rather than on the next reload.
          prefer: readPreferences().uploadBackend,
          contentHash: item.contentHash,
          allowDuplicate: item.allowDuplicate,
          onProgress: loaded => this.progress(item.id, loaded, item.size),
          signal: controller.signal
        });
        created = (result.file as DriveFile) ?? null;
      } else {
        created = await this.uploadSmall(source, target, item, controller.signal);
      }

      // Store the thumbnail *before* the tile mounts: the tile immediately
      // requests /api/preview?thumb=1, and with no thumbnail yet the server
      // takes the slow path — re-downloading the original from Telegram and
      // resizing it — which is exactly what this avoids.
      if (created && canThumbnail(source)) await uploadThumbnail(created.id, source);
      if (created) this.hooks.onStored?.(created);

      // Replace: the new copy is safely stored, so the old one can go to Trash.
      // In this order deliberately — a failed replace must never lose a file.
      if (created && item.replaceFileId) await this.retireReplaced(item.replaceFileId);

      this.samples.delete(item.id);
      this.patch(item.id, { loaded: item.size, percent: 100, speed: null, eta: null, status: "done" });
      void forgetHandle(resumeKeyFor(source));
    } catch (error) {
      if (error instanceof UploadAbortedError || (error instanceof DOMException && error.name === "AbortError")) {
        // A pause already set the status and wants the row kept; a cancel has
        // already removed it. Either way there is nothing left to do.
        return;
      }
      // The server refused it as a duplicate. The client asks before queueing, so
      // reaching here means another tab stored the same file in between — and the
      // honest answer is the one the user would have been given: skip it.
      const duplicate = asDuplicate(error);
      if (duplicate) {
        this.samples.delete(item.id);
        this.patch(item.id, {
          status: "skipped",
          loaded: item.size,
          percent: 100,
          speed: null,
          eta: null,
          duplicateOf: duplicate
        });
        return;
      }
      this.fail(item.id, error);
    } finally {
      this.controllers.delete(item.id);
    }
  }

  /** Move the file a Replace superseded into Trash. Recoverable on purpose. */
  private async retireReplaced(fileId: string) {
    try {
      const response = await fetch(`/api/files/${fileId}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      this.hooks.onRemoved?.(fileId);
    } catch {
      // The new copy is stored either way; saying so beats failing the upload.
      toast.info("The new copy is stored, but the file it replaced could not be moved to Trash.");
    }
  }

  /** The one-request path for anything a bot can hold as a single document. */
  private async uploadSmall(source: File, target: string | null, item: UploadItem, signal: AbortSignal) {
    const form = new FormData();
    form.append("file", source);
    if (target) form.append("folderId", target);
    if (item.contentHash) form.append("contentHash", item.contentHash);
    if (item.allowDuplicate) form.append("allowDuplicate", "1");
    const result = await uploadFile<{ file: DriveFile }>(
      "/api/upload",
      form,
      percent => this.progress(item.id, Math.round((percent / 100) * item.size), item.size),
      signal
    );
    return result.data.file ?? null;
  }

  private fail(id: string, error: unknown) {
    const message = error instanceof Error ? error.message : "Upload failed";
    this.samples.delete(id);
    this.patch(id, { status: "error", error: message, speed: null, eta: null });
  }

  private progress(id: string, loaded: number, size: number) {
    const history = this.samples.get(id) ?? [];
    this.samples.set(id, history);
    this.assign(id, sampleRate(history, loaded, size));
    this.emitSoon();
    this.schedulePersist();
  }

  // ── Surviving a reload ────────────────────────────────────────────────────

  /** Progress is worth remembering, but not thirty times a second. */
  private schedulePersist() {
    if (this.persistTimer !== null || typeof window === "undefined") return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Write the queue out now.
   *
   * The debounce above means up to two seconds of progress lives only in memory,
   * so the page going away — hidden, unloaded — has to force it out first.
   */
  flush() {
    if (this.persistTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  private persist() {
    if (!this.hydrated) return;
    writePersisted(
      this.user,
      this.items
        .filter(
          it =>
            it.size > SINGLE_SHOT_LIMIT &&
            it.resumeKey &&
            (it.status === "uploading" || it.status === "pending" || it.status === "paused" || it.status === "error")
        )
        .map<PersistedUpload>(it => ({
          id: it.id,
          name: it.name,
          size: it.size,
          // From the item, not from `it.file`: a session restored after a reload
          // has no File, and writing 0 back would erase the timestamp the resume
          // key is built from — stranding the very session this preserves.
          lastModified: it.lastModified ?? it.file?.lastModified ?? 0,
          folderId: it.folderId ?? null,
          resumeKey: it.resumeKey as string,
          path: it.path,
          loaded: it.loaded,
          updatedAt: Date.now()
        }))
    );
  }

  /**
   * Read back the sessions a previous visit left behind.
   *
   * A `File` cannot survive a reload, so the bytes have to come from somewhere.
   * Chromium hands out a `FileSystemFileHandle` for dropped files, which is
   * storable and — when its read permission is still granted — usable without
   * asking, so those resume on their own. Everything else is listed as paused
   * with a Resume button, which is the closest the platform allows.
   */
  hydrate(user: string) {
    if (this.hydrated) return;
    this.hydrated = true;
    this.user = user;

    const sessions = readPersisted(user);
    if (!sessions.length) return;

    const restored: UploadItem[] = sessions.map(session => ({
      id: session.id,
      name: session.name,
      size: session.size,
      loaded: session.loaded,
      percent: session.size ? Math.min(100, Math.round((session.loaded / session.size) * 100)) : 0,
      speed: null,
      eta: null,
      status: "paused",
      file: null,
      lastModified: session.lastModified,
      folderId: session.folderId,
      resumeKey: session.resumeKey,
      path: session.path
    }));
    this.items = [...restored.filter(it => !this.items.some(x => x.resumeKey === it.resumeKey)), ...this.items];
    this.emit();

    void (async () => {
      for (const session of sessions) {
        const file = await this.recall(session, { prompt: false });
        if (file) this.attach(session.id, file);
      }
    })();
  }

  /**
   * Find the bytes for a restored session without asking the user.
   *
   * Two sources, because a file inside a dropped folder has no handle of its own:
   * the file's own remembered handle, or the tree's handle walked down the item's
   * relative path. Folder uploads had neither before, which is why they always
   * came back needing a manual re-pick — once per file.
   */
  private async recall(
    session: { resumeKey: string; path?: string; name: string; size: number; lastModified: number },
    options: { prompt: boolean }
  ): Promise<File | null> {
    const handle = await recallHandle(session.resumeKey);
    if (handle && handle.kind === "file") {
      const file = await fileFromHandle(handle, options);
      if (file && matchesSession(file, session)) return file;
    }
    if (session.path?.includes("/")) {
      const file = await recallFromDirectory(session.path, options);
      if (file && matchesSession(file, session)) return file;
    }
    return null;
  }

  /** Resume with the file the browser already knows about, or ask for it. */
  private async reattach(item: UploadItem) {
    if (item.resumeKey && item.lastModified) {
      const file = await this.recall(
        {
          resumeKey: item.resumeKey,
          path: item.path,
          name: item.name,
          size: item.size,
          lastModified: item.lastModified
        },
        { prompt: true }
      );
      if (file) {
        this.attach(item.id, file);
        return;
      }
    }
    this.repick(item);
  }

  /** Hand the file back by picking it again — the fallback when no handle exists. */
  private repick(item: UploadItem) {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => {
      const picked = input.files?.[0];
      if (!picked) return;
      // Name and size must match, or this is a different file and its chunks are
      // not the ones the server is holding. The timestamp is part of the resume
      // key too, but a mismatch there is harmless: the key simply does not
      // match, so the server starts a fresh session instead of resuming.
      if (picked.name !== item.name || picked.size !== item.size) {
        toast.error(`That is not the same file — pick "${item.name}" to carry on where it stopped.`);
        return;
      }
      if (item.lastModified && picked.lastModified !== item.lastModified) {
        toast.info(`"${picked.name}" has changed since the upload started, so it will be sent from the beginning.`);
      }
      this.attach(item.id, picked);
    };
    input.click();
  }
}

const EMPTY: UploadItem[] = [];

/** The duplicate a refusal names, whichever of the two upload paths raised it. */
function asDuplicate(error: unknown): { id: string; name: string } | null {
  if (error instanceof DuplicateFileError) return error.existing;
  if (error instanceof ApiError && error.status === 409) {
    const duplicate = (error.details as { duplicate?: { id: string; name: string } } | undefined)?.duplicate;
    if (duplicate?.id) return duplicate;
  }
  return null;
}

/**
 * Store a browser-made thumbnail alongside the upload.
 *
 * Bounded: a slow thumbnail must never hold up the queue. If it times out the
 * server falls back to generating one on first view.
 */
async function uploadThumbnail(fileId: string, source: File) {
  try {
    const thumb = await makeThumbnail(source);
    if (!thumb) return;
    const form = new FormData();
    form.append("thumb", thumb);
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 15_000);
    try {
      await fileFetch(`/api/upload/thumb/${fileId}`, { method: "POST", body: form, signal: abort.signal });
    } finally {
      window.clearTimeout(timer);
    }
  } catch {
    /* the server still generates one on first view */
  }
}

export const uploads = new UploadManager();
