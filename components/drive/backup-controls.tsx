"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api-client";
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

type Folder = { id: string; name: string; parentId: string | null };
function folderPath(folder: Folder, folders: Folder[]) {
  const parts = [folder.name], seen = new Set([folder.id]);
  let parent = folder.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const node = folders.find(item => item.id === parent);
    if (!node) break;
    parts.unshift(node.name); parent = node.parentId;
  }
  return "My Drive / " + parts.join(" / ");
}

export function BackupDestination({ value, automaticName, onChange }: {
  value: string | null; automaticName: string; onChange: (id: string | null, name: string) => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try { const data = await apiFetch<{folders: Folder[]}>("/api/folders?flat=1"); setFolders(data.folders); setError(""); }
    catch { setError("Could not load destination folders. Try Refresh folders."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className="space-y-2">
    <label className="block t-sm">Save backups into
      <select aria-label="Save backups into" className="field mt-1.5 w-full" value={value ?? ""}
        onChange={event => {
          const folder = folders.find(item => item.id === event.target.value);
          onChange(folder?.id ?? null, folder ? folderPath(folder, folders) : automaticName);
        }}>
        <option value="">{automaticName} (created when backup starts)</option>
        {value && !folders.some(folder => folder.id === value) ? <option value={value}>Current destination</option> : null}
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-ghost" onClick={() => void load()}>Refresh folders</button>
      <button className="btn btn-ghost" onClick={() => setCreating(!creating)}>New destination folder</button>
      {value ? <a className="btn btn-ghost" href={`/drive?folder=${encodeURIComponent(value)}`}>Open destination</a> : null}
    </div>
    {creating ? <form className="flex flex-wrap gap-2" onSubmit={async event => {
      event.preventDefault();
      if (saving || !newName.trim()) return;
      setSaving(true);
      try {
        const data = await apiFetch<{ folder: Folder }>("/api/folders", {method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({name:newName.trim(),parentId:value})});
        await load(); onChange(data.folder.id, data.folder.name); setNewName(""); setCreating(false);
      } catch { setError("Could not create that folder. Check its name and try again."); }
      finally { setSaving(false); }
    }}>
      <input aria-label="New backup folder name" className="field min-w-0 flex-1" value={newName} required maxLength={80}
        placeholder="Folder name" onChange={event => setNewName(event.target.value)} />
      <button className="btn btn-accent" type="submit" disabled={saving}>{saving ? "Creating…" : "Create folder"}</button>
    </form> : null}
    {error ? <p role="alert" className="t-xs">{error}</p> : null}
    <p className="t-xs" style={{color:"var(--text-3)"}}>Destination changes apply to new transfers or runs. Already queued files keep their destination.
      Use Re-check all if you want old source files copied into a new destination.</p>
  </div>;
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
