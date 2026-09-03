"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Pause, Play, RotateCw, X } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { DURATION, EASE, useReducedMotion } from "@/lib/motion";
import { formatEta, formatSpeed, type DownloadItem, type TransferItem } from "./types";

/**
 * One panel for everything moving in either direction.
 *
 * Uploads and downloads were two different experiences before — a tray for one
 * and nothing at all for the other. They are the same thing from the user's
 * side: a named file, a percentage, how fast it is going and how long is left.
 * So they share a row, and the only difference is which way the arrow points.
 *
 * Speed and ETA come from byte deltas over a short rolling window (see
 * `sampleRate`), not from a whole-transfer average — an average converges and
 * stops telling you anything about the connection you have right now.
 */
export function TransferPanel({
  transfers,
  open,
  onToggle,
  onCancelUpload,
  onCancelAll,
  onPauseUpload,
  onResumeUpload,
  onPauseAll,
  onResumeAll,
  onRetryUpload,
  onCancelDownload,
  onRetryDownload,
  onDismiss
}: {
  transfers: TransferItem[];
  open: boolean;
  onToggle: () => void;
  onCancelUpload: (id: string) => void;
  onCancelAll: () => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (id: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onRetryUpload: (id: string) => void;
  onCancelDownload: (id: string) => void;
  onRetryDownload: (item: DownloadItem) => void;
  onDismiss: (id: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  if (!transfers.length) return null;

  const active = transfers.filter(t => t.status === "uploading" || t.status === "downloading");
  const done = transfers.filter(t => t.status === "done").length;
  const failed = transfers.filter(t => t.status === "error").length;
  const paused = transfers.filter(t => t.status === "paused").length;
  const uploadsPresent = transfers.some(t => t.kind === "upload");
  // "Pause all" only means something while something is actually moving, and
  // "Resume all" only while something is stopped but still holds its bytes.
  const pausableUploads = transfers.some(
    t => t.kind === "upload" && (t.status === "uploading" || t.status === "pending")
  );
  const resumableUploads = transfers.some(
    t => t.kind === "upload" && (t.status === "paused" || t.status === "error")
  );

  const totalBytes = transfers.reduce((sum, t) => sum + t.size, 0);
  const loadedBytes = transfers.reduce((sum, t) => sum + (t.status === "done" ? t.size : t.loaded), 0);
  const speed = active.reduce((sum, t) => sum + (t.speed ?? 0), 0);
  const eta = speed > 0 ? (totalBytes - loadedBytes) / speed : null;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: reduceMotion ? DURATION.fast : DURATION.base, ease: EASE }}
      className="mt-3 overflow-hidden rounded-xl"
      style={{ border: "1px solid var(--border-dim)", background: "var(--surface)" }}
    >
      <div className="px-3 py-2" style={{ borderBottom: open ? "1px solid var(--border-dim)" : "none" }}>
        <div className="flex items-center justify-between gap-2">
          <button onClick={onToggle} className="t-xs flex min-w-0 items-center gap-1.5" style={{ color: "var(--text-2)" }}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
            <span className="truncate">
              {done}/{transfers.length} done{failed ? ` · ${failed} failed` : ""}
              {paused ? ` · ${paused} paused` : ""}
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-2">
            {pausableUploads ? (
              <button onClick={onPauseAll} className="t-xs font-semibold" style={{ color: "var(--text-2)" }}>
                Pause all
              </button>
            ) : null}
            {resumableUploads ? (
              <button onClick={onResumeAll} className="t-xs font-semibold" style={{ color: "var(--accent)" }}>
                Resume all
              </button>
            ) : null}
            {active.length ? (
              <button onClick={onCancelAll} className="t-xs font-semibold" style={{ color: "var(--danger)" }}>
                Cancel all
              </button>
            ) : null}
          </span>
        </div>
        <p className="mono mt-1 truncate" style={{ color: "var(--text-3)" }}>
          {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
          {active.length ? ` · ${formatSpeed(speed || null)} · ${formatEta(eta)} left` : ""}
        </p>
        {/* Said once, plainly, because the alternative is someone closing the
            tab expecting the upload to carry on. It cannot: a browser loses the
            file handle along with the document. Everything short of that does. */}
        {uploadsPresent ? (
          <p className="t-xs mt-1 leading-snug" style={{ color: "var(--text-3)" }}>
            Uploads keep running as you move around the app. Closing the tab pauses them — they carry on from where
            they stopped when you return.
          </p>
        ) : null}
      </div>

      {open ? (
        <div className="max-h-56 space-y-1.5 overflow-y-auto p-2">
          <AnimatePresence initial={false}>
            {transfers.map(item => (
              <motion.div
                key={item.id}
                layout={reduceMotion ? false : "position"}
                initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8 }}
                transition={{ duration: reduceMotion ? DURATION.fast : DURATION.base, ease: EASE }}
                className="rounded-lg p-2"
                style={{ background: "var(--bg-1)" }}
              >
                <TransferRow
                  item={item}
                  onCancel={() => (item.kind === "upload" ? onCancelUpload(item.id) : onCancelDownload(item.id))}
                  onRetry={() => (item.kind === "download" ? onRetryDownload(item) : onRetryUpload(item.id))}
                  onPause={() => item.kind === "upload" && onPauseUpload(item.id)}
                  onResume={() => item.kind === "upload" && onResumeUpload(item.id)}
                  onDismiss={() => onDismiss(item.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : null}
    </motion.div>
  );
}

function TransferRow({
  item,
  onCancel,
  onRetry,
  onPause,
  onResume,
  onDismiss
}: {
  item: TransferItem;
  onCancel: () => void;
  onRetry: () => void;
  onPause: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const inFlight = item.status === "uploading" || item.status === "downloading" || item.status === "pending";
  const Arrow = item.kind === "upload" ? ArrowUpFromLine : ArrowDownToLine;

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Arrow
            className="h-3 w-3 shrink-0"
            style={{ color: item.kind === "upload" ? "var(--accent)" : "var(--accent-2)" }}
            aria-label={item.kind === "upload" ? "Uploading" : "Downloading"}
          />
          <span className="t-xs truncate font-medium" style={{ color: "var(--text-1)" }} title={item.name}>
            {item.name}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {item.status === "pending" ? <span className="mono" style={{ color: "var(--text-3)" }}>wait</span> : null}
          {item.status === "uploading" || item.status === "downloading" ? (
            <span className="mono" style={{ color: "var(--accent)" }}>{item.percent}%</span>
          ) : null}
          {item.status === "done" ? <Check className="h-3.5 w-3.5" style={{ color: "var(--emerald)" }} /> : null}
          {/* Only uploads pause. A download is one response being consumed, and
              stopping it mid-body cannot be picked up where it stopped. */}
          {item.kind === "upload" && (item.status === "uploading" || item.status === "pending") ? (
            <button onClick={onPause} aria-label={`Pause ${item.name}`} title="Pause">
              <Pause className="h-3.5 w-3.5" style={{ color: "var(--text-2)" }} />
            </button>
          ) : null}
          {item.status === "paused" ? (
            <button
              onClick={onResume}
              className="mono flex items-center gap-1"
              style={{ color: "var(--accent)" }}
              aria-label={`Resume ${item.name}`}
            >
              <Play className="h-3 w-3" />
              Resume
            </button>
          ) : null}
          {item.status === "error" ? (
            <button onClick={onRetry} aria-label="Retry">
              <RotateCw className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
            </button>
          ) : null}
          <button onClick={() => (inFlight ? onCancel() : onDismiss())} aria-label={inFlight ? "Cancel" : "Dismiss"}>
            <X className="h-3.5 w-3.5" style={{ color: "var(--text-3)" }} />
          </button>
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full" style={{ background: "var(--surface-hi)" }}>
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", inFlight && item.percent > 0 && "progress-bar")}
          style={{
            width: `${item.status === "done" ? 100 : item.percent}%`,
            background: item.status === "error" ? "var(--danger)" : item.status === "done" ? "var(--emerald)" : undefined
          }}
        />
      </div>

      {item.status === "error" ? (
        <p className="t-xs mt-1 truncate" style={{ color: "var(--danger)" }} title={item.error}>
          {item.error}
        </p>
      ) : item.status === "paused" ? (
        <p className="t-xs mt-1 truncate" style={{ color: "var(--text-3)" }}>
          {formatBytes(item.loaded)} of {formatBytes(item.size)} already stored —{" "}
          {item.kind === "upload" && !item.file ? "resume and pick the file again" : "resume to send the rest"}.
        </p>
      ) : (
        <p className="mono mt-1 truncate" style={{ color: "var(--text-3)" }}>
          {formatBytes(item.status === "done" ? item.size : item.loaded)}
          {item.size ? ` / ${formatBytes(item.size)}` : ""}
          {inFlight && item.speed ? ` · ${formatSpeed(item.speed)} · ${formatEta(item.eta)}` : ""}
        </p>
      )}
    </>
  );
}
