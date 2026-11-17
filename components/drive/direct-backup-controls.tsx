"use client";

import { useSyncExternalStore } from "react";
import { CloudUpload, Pause, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { nativeDirectBackup } from "@/lib/native-direct-backup";
import { formatBytes } from "@/lib/utils";
import type { NativeBackupStatus } from "@/lib/native-backup";

/** The run controls for direct album backup. The route itself is chosen in the hub. */
export function DirectBackupControls({ user, status, busy, onRescan }: {
  user: string; status: NativeBackupStatus; busy: boolean; onRescan: () => void;
}) {
  const snapshot = useSyncExternalStore(nativeDirectBackup.subscribe, nativeDirectBackup.getSnapshot, nativeDirectBackup.getServerSnapshot);
  const state = snapshot.user === user ? snapshot : nativeDirectBackup.getServerSnapshot();
  if ((status.backupVersion ?? 0) < 3) return <p className="t-xs">Update the Android app to add direct album backup.</p>;
  const percent = state.size ? Math.min(100, Math.round((state.sent / state.size) * 100)) : 0;
  return <div className="space-y-3">
    {state.name ? <div className="rounded-xl p-3" style={{ background: "var(--surface)" }}>
      <p className="t-sm truncate font-semibold" title={state.name}>{state.name}</p>
      <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: "var(--border-dim)" }}>
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${percent}%`, background: "linear-gradient(90deg,var(--accent),var(--accent-2))" }} />
      </div>
      <p className="mono t-xs mt-1" style={{ color: "var(--text-3)" }}>{formatBytes(state.sent)} / {formatBytes(state.size)} · {state.saved} saved this run</p>
    </div> : null}
    <p role="status" className="t-xs flex items-center gap-1.5" style={{ color: "var(--text-2)" }}>
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--emerald)" }} /> {state.message}
    </p>
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-accent" disabled={busy || (!state.running && (!status.enabled || snapshot.running))} onClick={() => {
        if (state.running) nativeDirectBackup.stop(); else void nativeDirectBackup.start(user);
      }}>{state.running ? <Pause className="h-4 w-4" /> : state.name ? <Play className="h-4 w-4" /> : <CloudUpload className="h-4 w-4" />}
        {state.running ? "Pause" : "Back up directly now"}</button>
      <button className="btn btn-ghost" disabled={busy || snapshot.running} onClick={onRescan}>
        <RotateCcw className="h-4 w-4" /> Re-check albums
      </button>
    </div>
  </div>;
}
