"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api-client";
import { DestinationTile, useFolders } from "./folder-picker";
import { nativeBackup } from "@/lib/native-backup";
import { uploads } from "@/lib/upload-manager";
import { readBackupState } from "@/lib/photo-backup";
import { formatBytes } from "@/lib/utils";
import type { BackupNetworkMode } from "@/lib/backup-network";

export function BackupNetworkSelect({ value, onChange, disabled = false }: {
  value: BackupNetworkMode | "off"; onChange: (value: BackupNetworkMode | "off") => void; disabled?: boolean;
}) {
  return <label className="block t-sm">Backup connection
    <select aria-label="Backup connection" className="field mt-1.5 w-full" value={value} disabled={disabled}
      onChange={event => onChange(event.target.value as BackupNetworkMode | "off")}>
      <option value="off">No backup — off</option>
      <option value="wifi">Wi-Fi only</option>
      <option value="mobile">Mobile data only</option>
      <option value="both">Wi-Fi and mobile data</option>
    </select>
  </label>;
}

/** Where browser backups land, chosen with the folder browser. */
export function BackupDestination({ value, automaticName, onChange }: {
  value: string | null; automaticName: string; onChange: (id: string | null, name: string) => void;
}) {
  const { folders, reload } = useFolders();
  return <DestinationTile label="Save backups into" value={value} automaticName={automaticName}
    folders={folders} onReload={reload} onChange={onChange} />;
}

type Row = { name: string; size: number; status: string; error?: string; time?: number; path?: string };
export function BackupFiles({ native = false, user, folderId }: { native?: boolean; user: string; folderId: string | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"waiting" | "saved" | "activity" | "failed">("waiting");
  const [skip, setSkip] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const queue = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getServerSnapshot);
  const [total, setTotal] = useState<number | null>(null);
  const generation = useRef(0);
  const waiting = queue.filter(item => item.backup && item.status !== "done" && item.status !== "skipped");
  const load = useCallback(async () => {
    if (!open) return;
    const request = ++generation.current;
    const update = (files: Row[], hasMore: boolean, count: number | null = null) => {
      if (request !== generation.current) return;
      setRows(files); setMore(hasMore); setTotal(count);
    };
    setBusy(true); setError("");
    try {
      if (tab === "waiting" && native) {
        const result = await nativeBackup.pendingFiles({ skip, take: 50 });
        if (!result) throw new Error("Update the Android app to list waiting files.");
        update(result.files, result.hasMore);
      } else if (tab === "saved") {
        if (!folderId) { update([], false); return; }
        const result = await apiFetch<{files:Array<{originalName:string;size:number}>;hasMore:boolean;total:number}>(
          `/api/files?folderId=${encodeURIComponent(folderId)}&recursive=1&count=1&take=50&skip=${skip}`);
        update(result.files.map(file => ({name:file.originalName,size:file.size,status:"saved"})), result.hasMore, result.total);
      } else if (tab === "activity" || (tab === "failed" && native)) {
        const history = native ? (await nativeBackup.activity())?.files : readBackupState(user).history;
        if (!history) throw new Error("Update the app to view recent activity.");
        const filtered = tab === "failed" ? history.filter(file => file.status === "failed") : history;
        update(filtered.slice(skip, skip + 50), filtered.length > skip + 50);
      }
    } catch (err) { if(request===generation.current) setError(err instanceof Error ? err.message : "Could not load files."); }
    finally { if(request===generation.current) setBusy(false); }
  }, [open, tab, native, skip, folderId, user]);
  useEffect(() => { void load(); }, [load]);
  const local = tab === "failed" ? waiting.filter(item => item.status === "error") : waiting;
  const localTab = (tab === "waiting" || tab === "failed") && !native;
  const visible = localTab ? local.slice(skip, skip + 50) : rows;
  const hasMore = localTab ? local.length > skip + 50 : more;
  return <div className="mt-4 space-y-3">
    <button className="btn btn-ghost" onClick={() => setOpen(!open)}>{open ? "Hide backup files" : "Show backup files and progress"}</button>
    {open ? <>
      <div className="flex flex-wrap gap-2">
        {(["waiting","saved","failed","activity"] as const).map(value => <button className={tab===value?"btn btn-accent":"btn btn-ghost"}
          key={value} onClick={() => {setTab(value);setSkip(0);}}>
          {value==="waiting"?"Waiting / remaining":value==="saved"?"Files in destination":value==="failed"?"Failed files":"Recent activity"}</button>)}
        <button className="btn btn-ghost" disabled={busy} onClick={() => void load()}>Refresh list</button>
      </div>
      <p className="t-xs" style={{color:"var(--text-3)"}}>
        {tab==="activity"?"Latest 200 recorded file results on this device. Earlier files are in your destination folder.":
          tab==="failed"?"Failed files and their last recorded errors. Retry from Transfers in the browser, or Re-check everything in the Android app.":
          tab==="saved"?"Files currently saved in this destination folder; this may include files uploaded from other devices.":
          "Waiting means not yet processed with these source settings. Already-saved duplicates are skipped when the backup runs."}
      </p>
      {tab === "saved" && total !== null ? <p className="t-sm">{total} saved files in this destination and its subfolders</p> : null}
      {tab === "waiting" && !native ? <p className="t-sm">{waiting.length} remaining in this browser queue · {waiting.filter(item => item.status === "error").length} failed</p> : null}
      {busy ? <p className="t-sm" role="status">Loading file names…</p> : error ? <p role="alert" className="t-sm">{error}</p> :
        <ul className="max-h-80 space-y-2 overflow-y-auto" aria-label="Backup file list">
          {visible.length===0 ? <li className="t-sm">{tab==="saved"&&!folderId?"The destination will be created when backup starts.":"No files in this list."}</li> :
            visible.map((file,index) => <li key={`${file.name}-${index}`} className="rounded-lg p-2" style={{background:"var(--bg-1)"}}>
              <p className="t-sm break-all">{file.name}</p>
              <p className="t-xs">{formatBytes(file.size)} · {file.status.replaceAll("_"," ")}</p>
              {file.error ? <p className="t-xs break-words" style={{color:"var(--danger)"}}>{file.error}</p> : null}
            </li>)}
        </ul>}
      <div className="flex gap-2">
        <button className="btn btn-ghost" disabled={skip===0||busy} onClick={() => setSkip(Math.max(0,skip-50))}>Previous</button>
        <button className="btn btn-ghost" disabled={!hasMore||busy} onClick={() => setSkip(skip+50)}>Next 50</button>
      </div>
    </> : null}
  </div>;
}
