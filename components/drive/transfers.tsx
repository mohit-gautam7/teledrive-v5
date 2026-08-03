"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, RotateCw, X } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { DURATION, EASE } from "@/lib/motion";
import { formatEta, formatSpeed, type DownloadItem, type TransferItem, type UploadItem } from "./types";

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
  onRetryUpload,
  onResumeUpload,
  onCancelDownload,
  onRetryDownload,
  onDismiss
}: {
  transfers: TransferItem[];
  open: boolean;
  onToggle: () => void;
  onCancelUpload: (id: string) => void;
  onCancelAll: () => void;
  onRetryUpload: (item: UploadItem) => void;
  onResumeUpload: (item: UploadItem) => void;
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
          {active.length ? (
            <button onClick={onCancelAll} className="t-xs shrink-0 font-semibold" style={{ color: "var(--danger)" }}>
              Cancel all
            </button>
          ) : null}
        </div>
        <p className="mono mt-1 truncate" style={{ color: "var(--text-3)" }}>
          {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
          {active.length ? ` · ${formatSpeed(speed || null)} · ${formatEta(eta)} left` : ""}
        </p>
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
                  onRetry={() => {
                    if (item.kind === "download") {
                      onRetryDownload(item);
                      return;
                    }
                    // A restored session has no bytes to retry with, so retrying
                    // it means asking for the file back first.
                    if (item.file) onRetryUpload(item);
                    else onResumeUpload(item);
                  }}
                  onResume={() => item.kind === "upload" && onResumeUpload(item)}
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
  onResume,
  onDismiss
}: {
  item: TransferItem;
  onCancel: () => void;
  onRetry: () => void;
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
          {item.status === "paused" ? (
            <button onClick={onResume} className="mono" style={{ color: "var(--accent)" }}>
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
          {formatBytes(item.loaded)} of {formatBytes(item.size)} already stored — resume to send the rest.
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

/**
 * Percent, speed and ETA from a series of byte counts.
 *
 * Shared by both directions so an upload and a download cannot disagree about
 * what "12 MB/s" means. The window is deliberately short: long enough to ride
 * out one slow chunk, short enough that the number follows the connection.
 */
const SPEED_WINDOW_MS = 6000;

export function sampleRate(
  samples: Array<{ t: number; loaded: number }>,
  loaded: number,
  size: number
): Pick<DownloadItem, "loaded" | "percent" | "speed" | "eta"> {
  const now = Date.now();
  samples.push({ t: now, loaded });
  while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift();

  const first = samples[0];
  const elapsed = (now - first.t) / 1000;
  const moved = loaded - first.loaded;
  const speed = elapsed >= 0.75 && moved > 0 ? moved / elapsed : null;

  return {
    loaded,
    percent: size ? Math.min(100, Math.round((loaded / size) * 100)) : 0,
    speed,
    eta: speed && speed > 0 && size ? Math.max(0, (size - loaded) / speed) : null
  };
}
