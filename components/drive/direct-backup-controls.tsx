"use client";

import { useSyncExternalStore } from "react";
import { CloudUpload, Pause, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { nativeDirectBackup } from "@/lib/native-direct-backup";
import { formatBytes } from "@/lib/utils";
import type { NativeBackupStatus } from "@/lib/native-backup";

export function DirectBackupControls({ user, status, busy, onTransport, onRescan }: {
  user: string; status: NativeBackupStatus; busy: boolean;
  onTransport: (transport: "direct" | "relay") => void; onRescan: () => void;
}) {
  const snapshot = useSyncExternalStore(nativeDirectBackup.subscribe, nativeDirectBackup.getSnapshot, nativeDirectBackup.getServerSnapshot);
  const state = snapshot.user === user ? snapshot : nativeDirectBackup.getServerSnapshot();
  const direct = status.transport === "direct";
  if ((status.backupVersion ?? 0) < 3) return <p className="t-xs mt-3">Update the Android app to add direct album backup.</p>;
  return <div className="mt-4 space-y-3 rounded-xl border p-4" style={{ borderColor: "var(--accent-border)", background: "var(--accent-dim)" }}>
    <label className="block t-sm font-medium">Backup route
      <select className="field mt-2 w-full" value={direct ? "direct" : "relay"} disabled={busy || snapshot.running}
        onChange={event => onTransport(event.target.value as "direct" | "relay")}>
        <option value="direct">Direct to Telegram · keep the app open</option>
        <option value="relay">File server · runs in the background</option>
      </select>
    </label>
    <p className="t-xs leading-relaxed" style={{ color: "var(--text-2)" }}>
      {direct ? "Original photos and videos go from this phone straight to Telegram. Vercel receives small metadata requests; Render is not needed for this backup. Closing or hiding the app pauses the run."
        : "Android backs up through your file server even when the app is closed. This uses that server’s bandwidth and requires access to it on your network."}
    </p>
    {direct ? <>
      <div className="flex flex-wrap gap-2">
        <span className="chip"><ShieldCheck className="h-3.5 w-3.5" /> No relay fallback</span>
        <span className="chip">{state.saved} confirmed this run</span>
      </div>
      {state.name ? <div>
        <p className="t-sm truncate" title={state.name}>{state.name}</p>
        <progress aria-label="Direct backup progress" className="mt-2 h-1.5 w-full accent-cyan-400" value={state.sent} max={Math.max(1, state.size)} />
        <p className="mono t-xs mt-1">{formatBytes(state.sent)} / {formatBytes(state.size)}</p>
      </div> : null}
      <p role="status" className="t-sm">{state.message}</p>
      <div className="flex flex-wrap gap-2">
      <button className="btn btn-accent" disabled={busy || (!state.running && (!status.enabled || snapshot.running))} onClick={() => {
        if (state.running) nativeDirectBackup.stop(); else void nativeDirectBackup.start(user);
      }}>{state.running ? <Pause className="h-4 w-4" /> : state.name ? <Play className="h-4 w-4" /> : <CloudUpload className="h-4 w-4" />}
        {state.running ? "Pause direct backup" : "Back up directly now"}</button>
      <button className="btn btn-ghost" disabled={busy || snapshot.running} onClick={onRescan}>
        <RotateCcw className="h-4 w-4" /> Re-check selected albums
      </button>
      </div>
    </> : null}
  </div>;
}
