"use client";

import { nativeBackup, nativeBackupAvailable } from "@/lib/native-backup";
import { browserLinked, checkDirectConnection, directConfig } from "@/lib/direct-upload";
import { DuplicateFileError, uploadFileInChunks } from "@/lib/chunked-upload";
import { NativeMediaFile, type NativeMedia } from "@/lib/native-media-file";
import { backupConnection, backupNetworkAllowed } from "@/lib/backup-network";
import { DIRECT_MAX_BYTES } from "@/lib/direct-parts";
import { apiFetch } from "@/lib/api-client";

type Batch = { runId: string; accountId: string; folderId: string; files: NativeMedia[] };
type Bridge = {
  directBegin(options: { accountId: string }): Promise<Batch>;
  directRead(options: { runId: string; id: string; offset: number; length: number }): Promise<{ data: string }>;
  directAcknowledge(options: { runId: string; id: string }): Promise<unknown>;
  directEnd(options: { runId: string }): Promise<unknown>;
  /** App version 4+: keep the app alive (foreground service) during a run. */
  directService?(options: { running: boolean; text?: string }): Promise<unknown>;
};
type State = { user: string; running: boolean; name: string; sent: number; size: number; saved: number; message: string };
const EMPTY: State = { user: "", running: false, name: "", sent: 0, size: 0, saved: 0, message: "Ready for direct backup." };
let state = EMPTY;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };

function bridge(): Bridge {
  const win = window as unknown as { Capacitor?: { Plugins?: { Backup?: Bridge } } };
  const api = win.Capacitor?.Plugins?.Backup;
  if (!api) throw new Error("Direct album backup needs the updated Android app.");
  return api;
}

export const nativeDirectBackup = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  getServerSnapshot: () => EMPTY,
  stop() { controller?.abort(); },
  async start(user: string) {
    if (controller || !nativeBackupAvailable()) return;
    const active = new AbortController();
    controller = active;
    publish({ ...EMPTY, user, running: true, message: "Checking Telegram and selected albums…" });
    // An app that can keep itself alive (version 4+, foreground service) keeps
    // backing up after it is minimised; an older one pauses when hidden, since
    // Android would freeze it part-way anyway.
    let background = false;
    const pauseWhenHidden = () => { if (!background && document.visibilityState === "hidden") active.abort(); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    const ensureActive = () => {
      if (active.signal.aborted || (!background && document.visibilityState === "hidden")) throw new DOMException("Paused", "AbortError");
    };
    let batch: Batch | null = null;
    try {
      const status = await nativeBackup.status();
      if (!status || (status.backupVersion ?? 0) < 3) throw new Error("Install the updated Android app for direct album backup.");
      if (!status.enabled || status.transport !== "direct") throw new Error("Turn backup on and choose Direct to Telegram first.");
      if (!await directConfig() || !browserLinked(user)) throw new Error("Connect this app in Settings → Direct upload first.");
      await checkDirectConnection(user);
      const identity = await apiFetch<{ user: { id: string } | null }>("/api/auth/me");
      if (!identity.user?.id) throw new Error("Sign in before starting backup.");
      const accountId = identity.user.id;
      ensureActive();
      await nativeBackup.keepAwake(true, "backup");
      const api = bridge();
      if ((status.backupVersion ?? 0) >= 4 && api.directService) {
        await api.directService({ running: true });
        background = true;
      }
      for (;;) {
        ensureActive();
        batch = await api.directBegin({ accountId });
        if (batch.accountId !== accountId) throw new Error("The signed-in account changed. Backup paused.");
        if (!batch.files.length) {
          publish({ message: "Up to date for your selected albums and size filters." });
          break;
        }
        for (const media of batch.files) {
          ensureActive();
          if (media.size <= 0) throw new Error(`${media.name} is empty or still being written. Finish saving it on the phone, then retry.`);
          if (media.size > DIRECT_MAX_BYTES) throw new Error(`${media.name} exceeds the direct-upload limit of 2,000 MiB. Adjust the backup size filter to continue.`);
          const runId = batch.runId;
          publish({ name: media.name, sent: 0, size: media.size, message: "Uploading directly to Telegram…" });
          const beforeSend = async () => {
            ensureActive();
            if (!backupNetworkAllowed(status.networkMode ?? "wifi", await backupConnection())) {
              throw new Error("Waiting for the selected backup network. Resume when connected.");
            }
            ensureActive();
          };
          const file = new NativeMediaFile(media, async (offset, length) => {
            await beforeSend();
            const response = await api.directRead({ runId, id: media.id, offset, length });
            return response.data;
          });
          try {
            await uploadFileInChunks({ file, user, folderId: media.folderId || batch.folderId, directOnly: true,
              signal: active.signal, beforeSend, onProgress: sent => publish({ sent }) });
          } catch (error) {
            if (!(error instanceof DuplicateFileError)) throw error;
          }
          // Only this native acknowledgement advances the MediaStore cursor.
          ensureActive();
          await api.directAcknowledge({ runId, id: media.id });
          publish({ saved: state.saved + 1, sent: media.size, message: "Saved to your drive." });
          window.dispatchEvent(new Event("teledrive-direct-backup-saved"));
        }
        await api.directEnd({ runId: batch.runId });
        batch = null;
      }
    } catch (error) {
      publish({ message: active.signal.aborted ? "Paused. Reopen the app and continue; confirmed files stay saved."
        : (error as Error)?.message || "Direct backup failed. No file bytes were relayed." });
    } finally {
      try {
        if (batch) await bridge().directEnd({ runId: batch.runId });
      } catch { /* The native lock also expires if the bridge has gone away. */ }
      if (background) await bridge().directService?.({ running: false }).catch(() => {});
      try { await nativeBackup.keepAwake(false, "backup"); }
      finally {
        document.removeEventListener("visibilitychange", pauseWhenHidden);
        controller = null;
        publish({ running: false });
      }
    }
  }
};
