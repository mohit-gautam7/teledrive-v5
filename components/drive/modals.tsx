"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CopyPlus, Folder as FolderIcon, Home, Info, Loader2, RefreshCw, SkipForward } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { fadeIn, sheet, useReducedMotion } from "@/lib/motion";
import type { DuplicateChoice } from "@/lib/duplicate-plan";
import type { DriveFolder, PropsTarget } from "./types";

/** Shared modal chrome: dimmed backdrop, escape-to-close, click-outside-to-close.
 *  Uses dvh so the sheet is never clipped by mobile browser chrome. */
function Shell({ onClose, children, wide }: { onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    // Stop the page behind the modal from scrolling on touch.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <motion.div
      {...fadeIn(reduceMotion)}
      className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4"
      style={{ background: "rgba(3,5,10,0.7)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        {...sheet(reduceMotion)}
        className="panel safe-bottom w-full overflow-hidden rounded-b-none sm:rounded-2xl"
        style={{
          maxWidth: wide ? 560 : 440,
          background: "var(--bg-1)",
          boxShadow: "var(--shadow-lg)",
          maxHeight: "88dvh",
          overflowY: "auto"
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Grab handle, mobile only */}
        <div className="flex justify-center pb-1 pt-3 sm:hidden">
          <span className="h-1 w-9 rounded-full" style={{ background: "var(--border-med)" }} />
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

export function NameModal({
  title,
  hint,
  initialValue,
  confirmLabel,
  onConfirm,
  onClose
}: {
  title: string;
  hint: string;
  initialValue: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <Shell onClose={onClose}>
      <div className="p-5 sm:p-6">
        <h2 className="display t-h2">{title}</h2>
        <p className="t-sm mt-1" style={{ color: "var(--text-3)" }}>{hint}</p>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && value.trim()) onConfirm(value.trim());
          }}
          className="field mt-4"
          style={{ minHeight: 44 }}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={() => value.trim() && onConfirm(value.trim())} disabled={!value.trim()} className="btn btn-primary">
            {confirmLabel}
          </button>
        </div>
      </div>
    </Shell>
  );
}

export function ConfirmModal({
  title,
  body,
  danger,
  onConfirm,
  onClose
}: {
  title: string;
  body: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Shell onClose={onClose}>
      <div className="p-5 sm:p-6">
        <h2 className="display t-h2" style={{ color: danger ? "var(--danger)" : "var(--text-1)" }}>{title}</h2>
        <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-2)" }}>{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={onConfirm} className={danger ? "btn btn-danger" : "btn btn-primary"}>Confirm</button>
        </div>
      </div>
    </Shell>
  );
}

/**
 * Pick a destination folder.
 *
 * The tree arrives as a prop rather than being fetched here. The drive has held
 * the whole thing in memory since it loaded, so refetching it meant every Move
 * opened on "Loading folders…" and spent a request — and a connection — on data
 * that was already on the page.
 */
export function MoveModal({
  count,
  currentFolderId,
  folders,
  onMove,
  onClose
}: {
  count: number;
  currentFolderId: string | null;
  folders: DriveFolder[];
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const nameById = new Map(folders.map(f => [f.id, f]));
  const pathOf = (folder: DriveFolder) => {
    const parts = [folder.name];
    let parentId = folder.parentId;
    for (let guard = 0; parentId && guard < 20; guard++) {
      const parent = nameById.get(parentId);
      if (!parent) break;
      parts.unshift(parent.name);
      parentId = parent.parentId;
    }
    return parts.join(" / ");
  };

  return (
    <Shell onClose={onClose}>
      <div className="p-5 sm:p-6">
        <h2 className="display t-h2">Move {count > 1 ? `${count} files` : "file"}</h2>
        <p className="t-sm mt-1" style={{ color: "var(--text-3)" }}>Choose a destination.</p>
        <div className="mt-4 max-h-[46vh] space-y-1 overflow-y-auto pr-1">
          <button
            onClick={() => onMove(null)}
            disabled={currentFolderId === null}
            className="btn btn-ghost w-full justify-start disabled:opacity-30"
          >
            <Home className="h-4 w-4" style={{ color: "var(--accent)" }} /> My Files (root)
          </button>
          {folders.length === 0 ? (
            <p className="t-sm py-6 text-center" style={{ color: "var(--text-3)" }}>No folders yet — create one first.</p>
          ) : (
            folders.map(folder => (
              <button
                key={folder.id}
                onClick={() => onMove(folder.id)}
                disabled={folder.id === currentFolderId}
                className="btn btn-ghost w-full justify-start disabled:opacity-30"
              >
                <FolderIcon className="h-4 w-4 shrink-0" style={{ color: "var(--accent-2)" }} />
                <span className="truncate">{pathOf(folder)}</span>
              </button>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
        </div>
      </div>
    </Shell>
  );
}

export function PropertiesModal({ target, onClose }: { target: PropsTarget; onClose: () => void }) {
  const rows: Array<[string, string]> =
    target.kind === "file"
      ? [
          ["Name", target.file.originalName],
          ["Type", target.file.mimeType || "file"],
          ["Size", formatBytes(target.file.size)],
          ["Stored via", target.file.backend === "mtproto" ? "Your Telegram account" : "Telegram bot chat"],
          ["Favourite", target.file.isFavorite ? "Yes" : "No"],
          ["Added", new Date(target.file.createdAt).toLocaleString()]
        ]
      : [
          ["Name", target.folder.name],
          ["Items", String(target.folder.fileCount ?? 0)],
          ["Total size", formatBytes(target.folder.size ?? 0)],
          ["Created", new Date(target.folder.createdAt).toLocaleString()]
        ];

  return (
    <Shell onClose={onClose}>
      <div className="p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)" }}>
            {target.kind === "folder" ? (
              <FolderIcon className="h-5 w-5" style={{ color: "var(--accent-2)" }} />
            ) : (
              <Info className="h-5 w-5" style={{ color: "var(--accent)" }} />
            )}
          </span>
          <h2 className="display t-h2">Properties</h2>
        </div>
        <dl className="space-y-3">
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-start justify-between gap-6">
              <dt className="mono shrink-0" style={{ color: "var(--text-3)" }}>{key}</dt>
              <dd className="t-sm m-0 break-words text-right" style={{ color: "var(--text-1)" }}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="btn btn-accent">Close</button>
        </div>
      </div>
    </Shell>
  );
}

/** Create a share with optional password + expiry, in one step. */
export function ShareModal({
  targetName,
  onCreate,
  onClose
}: {
  targetName: string;
  onCreate: (options: { password?: string; expiryDays?: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [expiryDays, setExpiryDays] = useState(0);
  const [busy, setBusy] = useState(false);

  return (
    <Shell onClose={onClose}>
      <div className="p-5 sm:p-6">
        <h2 className="display t-h2">Share link</h2>
        <p className="t-sm mt-1 break-words" style={{ color: "var(--text-3)" }}>{targetName}</p>

        <label className="eyebrow mt-5 block">Password (optional)</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Leave empty for no password"
          className="field mt-2"
          minLength={4}
        />

        <label className="eyebrow mt-4 block">Expires</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {[
            [0, "Never"],
            [1, "1 day"],
            [7, "7 days"],
            [30, "30 days"]
          ].map(([days, label]) => (
            <button
              key={String(days)}
              onClick={() => setExpiryDays(days as number)}
              className={expiryDays === days ? "btn btn-accent" : "btn btn-ghost"}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || (password.length > 0 && password.length < 4)}
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate({ password: password || undefined, expiryDays: expiryDays || undefined });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create &amp; copy
          </button>
        </div>
      </div>
    </Shell>
  );
}

// ── Duplicate uploads ────────────────────────────────────────────────────────

export type DuplicateEntry = {
  /** Position in the caller's batch, so a decision can be mapped back to a file. */
  index: number;
  name: string;
  size: number;
  /** Folder path relative to the drop target, for a folder upload. */
  location?: string;
  existing: { id: string; name: string };
};

const CHOICES: Array<{ value: DuplicateChoice; label: string; icon: typeof SkipForward; hint: string }> = [
  { value: "skip", label: "Skip", icon: SkipForward, hint: "Leave the copy that is already there" },
  { value: "replace", label: "Replace", icon: RefreshCw, hint: "Upload again and move the old one to Trash" },
  { value: "copy", label: "Keep both", icon: CopyPlus, hint: "Upload a second copy alongside it" }
];

/**
 * Ask once for the whole batch, not once per file.
 *
 * Re-dropping a folder of two hundred files is the normal case, not the edge
 * one, so the answer has to be a single decision with the option to disagree in
 * places — hence three buttons at the top and a per-file override below them.
 * Skip is the default because it is the only choice that cannot lose anything.
 */
export function DuplicateModal({
  entries,
  batchSize,
  onConfirm,
  onClose
}: {
  entries: DuplicateEntry[];
  /** How many files were picked in total, duplicates included. */
  batchSize: number;
  onConfirm: (choices: Record<number, DuplicateChoice>) => void;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<Record<number, DuplicateChoice>>(() =>
    Object.fromEntries(entries.map(entry => [entry.index, "skip" as DuplicateChoice]))
  );
  const setAll = (value: DuplicateChoice) =>
    setChoices(Object.fromEntries(entries.map(entry => [entry.index, value])));

  const counts = entries.reduce<Record<DuplicateChoice, number>>(
    (acc, entry) => {
      acc[choices[entry.index]]++;
      return acc;
    },
    { skip: 0, replace: 0, copy: 0 }
  );
  const uploading = batchSize - entries.length + counts.replace + counts.copy;

  return (
    <Shell onClose={onClose} wide>
      <div className="p-5 sm:p-6">
        <h2 className="display t-h2">
          {entries.length === 1 ? "This file is already here" : `${entries.length} files are already here`}
        </h2>
        <p className="t-sm mt-1" style={{ color: "var(--text-3)" }}>
          {entries.length === batchSize
            ? "Every file you picked is already stored in its destination."
            : `${entries.length} of ${batchSize} files you picked match something already stored.`}
        </p>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {CHOICES.map(({ value, label, icon: Icon, hint }) => (
            <button
              key={value}
              onClick={() => setAll(value)}
              title={hint}
              className="btn btn-ghost flex-col gap-1 py-3"
              style={{
                border: "1px solid var(--border-dim)",
                background: counts[value] === entries.length ? "var(--accent-dim)" : undefined,
                borderColor: counts[value] === entries.length ? "var(--accent-border)" : undefined
              }}
            >
              <Icon className="h-4 w-4" style={{ color: "var(--accent)" }} />
              <span className="t-xs font-semibold">{label} all</span>
            </button>
          ))}
        </div>

        <div className="mt-4 max-h-[38vh] space-y-1.5 overflow-y-auto pr-1">
          {entries.map(entry => (
            <div
              key={entry.index}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg p-2"
              style={{ background: "var(--bg-1)" }}
            >
              <span className="min-w-0 flex-1">
                <span className="t-xs block truncate font-medium" style={{ color: "var(--text-1)" }} title={entry.name}>
                  {entry.name}
                </span>
                <span className="mono block truncate" style={{ color: "var(--text-3)" }}>
                  {formatBytes(entry.size)}
                  {entry.location ? ` · ${entry.location}` : ""}
                  {entry.existing.name !== entry.name ? ` · stored as "${entry.existing.name}"` : ""}
                </span>
              </span>
              <span className="flex shrink-0 overflow-hidden rounded-lg" role="radiogroup" aria-label={`What to do with ${entry.name}`}>
                {CHOICES.map(({ value, label, hint }) => {
                  const active = choices[entry.index] === value;
                  return (
                    <button
                      key={value}
                      role="radio"
                      aria-checked={active}
                      title={hint}
                      onClick={() => setChoices(current => ({ ...current, [entry.index]: value }))}
                      className="t-xs px-2.5 py-1.5 font-semibold"
                      style={{
                        color: active ? "var(--accent)" : "var(--text-3)",
                        background: active ? "var(--accent-dim)" : "var(--surface)"
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <p className="mono" style={{ color: "var(--text-3)" }}>
            {uploading === 0 ? "Nothing will be uploaded" : `${uploading} file${uploading === 1 ? "" : "s"} will upload`}
            {counts.skip ? ` · ${counts.skip} skipped` : ""}
            {counts.replace ? ` · ${counts.replace} replaced` : ""}
          </p>
          <span className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button onClick={() => onConfirm(choices)} className="btn btn-primary">Continue</button>
          </span>
        </div>
      </div>
    </Shell>
  );
}
