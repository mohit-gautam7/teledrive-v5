"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder as FolderIcon, FolderPlus, Home, Loader2, Search, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Shell } from "./modals";

export type PickerFolder = { id: string; name: string; parentId: string | null };

/** The account's folders, loaded once per mount and refreshable. */
export function useFolders() {
  const [folders, setFolders] = useState<PickerFolder[] | null>(null);
  const reload = useCallback(async () => {
    try {
      const data = await apiFetch<{ folders: PickerFolder[] }>("/api/folders?flat=1");
      setFolders(data.folders);
      return data.folders;
    } catch {
      setFolders(current => current ?? []);
      return null;
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { folders, reload };
}

/** "My Drive / A / B" segments for a folder, root first. */
export function folderTrail(id: string | null, folders: PickerFolder[]): PickerFolder[] {
  const byId = new Map(folders.map(f => [f.id, f]));
  const trail: PickerFolder[] = [];
  for (let at = id ? byId.get(id) : undefined, guard = 0; at && guard < 30; guard++) {
    trail.unshift(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return trail;
}

/**
 * Browse the drive like a file manager and pick a folder: open a folder to go
 * inside, the breadcrumb to go back, "Save here" to choose where you are.
 * `automaticName`, when given, adds the "let the app create it" choice.
 */
export function FolderPicker({
  title,
  value,
  automaticName,
  automaticHint,
  folders,
  onReload,
  onPick,
  onClose
}: {
  title: string;
  value: string | null;
  automaticName?: string;
  automaticHint?: string;
  folders: PickerFolder[];
  onReload: () => Promise<PickerFolder[] | null>;
  onPick: (id: string | null, name: string) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState<string | null>(() => folders.find(f => f.id === value)?.parentId ?? null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  const children = useMemo(() => {
    const count = new Map<string, number>();
    folders.forEach(f => f.parentId && count.set(f.parentId, (count.get(f.parentId) ?? 0) + 1));
    return folders
      .filter(f => f.parentId === at)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ ...f, inside: count.get(f.id) ?? 0 }));
  }, [folders, at]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return folders.filter(f => f.name.toLowerCase().includes(q)).slice(0, 40);
  }, [folders, query]);

  const trail = folderTrail(at, folders);
  const here = trail.at(-1);

  async function create() {
    if (!newName.trim() || saving) return;
    setSaving(true);
    try {
      const data = await apiFetch<{ folder: PickerFolder }>("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), parentId: at })
      });
      await onReload();
      setNewName("");
      setCreating(false);
      setAt(data.folder.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell onClose={onClose} wide>
      <div className="flex flex-col" style={{ maxHeight: "84dvh" }}>
        <div className="p-5 pb-3">
          <h2 className="display t-h2">{title}</h2>
          <label className="field mt-3 flex items-center gap-2" style={{ minHeight: 42 }}>
            <Search className="h-4 w-4 shrink-0" style={{ color: "var(--text-3)" }} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search folders"
                   aria-label="Search folders" className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
          {!query ? (
            <nav className="mt-3 flex flex-wrap items-center gap-1" aria-label="Folder path">
              <button className="chip" onClick={() => setAt(null)}><Home className="h-3.5 w-3.5" /> My Drive</button>
              {trail.map(f => (
                <span key={f.id} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--text-3)" }} />
                  <button className="chip" onClick={() => setAt(f.id)}>{f.name}</button>
                </span>
              ))}
            </nav>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {query ? (
            matches.length ? matches.map(f => (
              <FolderRow key={f.id} name={f.name} sub={pathText(f.id, folders)} selected={f.id === value}
                         onOpen={() => { setAt(f.id); setQuery(""); }} />
            )) : <p className="t-sm p-4 text-center" style={{ color: "var(--text-3)" }}>No folder matches.</p>
          ) : (
            <>
              {at === null && automaticName ? (
                <button onClick={() => onPick(null, automaticName)}
                        className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition hover:bg-[var(--surface)]"
                        style={value === null ? { background: "var(--accent-dim)" } : undefined}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
                        style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))", color: "#fff" }}>
                    <Sparkles className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="t-sm block font-semibold">{automaticHint ? automaticName : "Automatic"}</span>
                    <span className="t-xs block" style={{ color: "var(--text-3)" }}>{automaticHint ?? `Creates “${automaticName}” for you`}</span>
                  </span>
                </button>
              ) : null}
              {children.length ? children.map(f => (
                <FolderRow key={f.id} name={f.name} sub={f.inside ? `${f.inside} folder${f.inside === 1 ? "" : "s"} inside` : "Empty of folders"}
                           selected={f.id === value} onOpen={() => setAt(f.id)} />
              )) : (
                <p className="t-sm p-4 text-center" style={{ color: "var(--text-3)" }}>No folders here yet.</p>
              )}
            </>
          )}
        </div>

        <div className="space-y-2 p-4" style={{ borderTop: "1px solid var(--border-dim)" }}>
          {creating ? (
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void create(); }}>
              <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} maxLength={80}
                     placeholder={`New folder in ${here?.name ?? "My Drive"}`} aria-label="New folder name" className="field min-w-0 flex-1" />
              <button className="btn btn-accent" disabled={saving || !newName.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
              </button>
            </form>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button className="btn btn-ghost" onClick={() => setCreating(c => !c)}>
              <FolderPlus className="h-4 w-4" /> New folder
            </button>
            <div className="flex gap-2">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!here} onClick={() => here && onPick(here.id, here.name)}>
                {here ? `Save to “${here.name}”` : "Open a folder"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function pathText(id: string, folders: PickerFolder[]) {
  return ["My Drive", ...folderTrail(id, folders).map(f => f.name)].join(" / ");
}

function FolderRow({ name, sub, selected, onOpen }: { name: string; sub: string; selected: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen}
            className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition hover:bg-[var(--surface)]"
            style={selected ? { background: "var(--accent-dim)" } : undefined}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: "var(--surface)", color: "var(--accent-2)" }}>
        <FolderIcon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="t-sm block truncate font-semibold">{name}</span>
        <span className="t-xs block truncate" style={{ color: "var(--text-3)" }}>{sub}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0" style={{ color: "var(--text-3)" }} />
    </button>
  );
}

/** A tappable "where it goes" tile: folder icon, name, full path, Change. */
export function DestinationTile({
  label,
  value,
  automaticName,
  folders,
  onChange,
  onReload
}: {
  label: string;
  value: string | null;
  automaticName: string;
  folders: PickerFolder[] | null;
  onChange: (id: string | null, name: string) => void;
  onReload: () => Promise<PickerFolder[] | null>;
}) {
  const [open, setOpen] = useState(false);
  const trail = folders && value ? folderTrail(value, folders) : [];
  const name = value ? trail.at(-1)?.name ?? "Chosen folder" : automaticName;
  return (
    <>
      <button onClick={() => setOpen(true)} disabled={!folders}
              className="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition hover:brightness-110"
              style={{ background: "var(--surface)", border: "1px solid var(--border-dim)" }}>
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
              style={{ background: "linear-gradient(135deg,var(--accent-dim),transparent)", color: "var(--accent)", border: "1px solid var(--accent-border)" }}>
          <FolderIcon className="h-6 w-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="eyebrow block">{label}</span>
          <span className="t-body block truncate font-semibold" style={{ color: "var(--text-1)" }}>{name}</span>
          <span className="t-xs block truncate" style={{ color: "var(--text-3)" }}>
            {value ? ["My Drive", ...trail.map(f => f.name)].join(" / ") : "Created when the first backup runs"}
          </span>
        </span>
        <span className="btn btn-ghost shrink-0" style={{ minHeight: 32, fontSize: 12 }}>Change</span>
      </button>
      {open && folders ? (
        <FolderPicker title={label} value={value} automaticName={automaticName} folders={folders} onReload={onReload}
                      onClose={() => setOpen(false)} onPick={(id, picked) => { setOpen(false); onChange(id, picked); }} />
      ) : null}
    </>
  );
}
