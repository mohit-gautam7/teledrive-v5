"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  Image as ImageIcon,
  Loader2,
  Maximize,
  Minimize,
  Music,
  Video as VideoIcon,
  X
} from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { fadeIn } from "@/lib/motion";
import type { DriveFile } from "./types";

const isImage = (f: DriveFile) =>
  f.mimeType.startsWith("image/") && !f.mimeType.includes("heic") && !f.mimeType.includes("heif");
const isVideo = (f: DriveFile) => f.mimeType.startsWith("video/");
const isAudio = (f: DriveFile) => f.mimeType.startsWith("audio/");

/** Shown when a file can't be rendered inline — always offers the download. */
function Unsupported({
  icon,
  title,
  body,
  onDownload
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onDownload: () => void;
}) {
  return (
    <div className="px-6 text-center">
      <span
        className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-2xl"
        style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)" }}
      >
        {icon}
      </span>
      <p className="t-body font-semibold" style={{ color: "var(--text-2)" }}>{title}</p>
      <p className="t-sm mx-auto mt-1 max-w-[40ch]" style={{ color: "var(--text-3)" }}>{body}</p>
      <button onClick={onDownload} className="btn btn-accent mt-5">
        <Download className="h-4 w-4" /> Download
      </button>
    </div>
  );
}

/**
 * A video that survives a bad connection.
 *
 * Streaming a multi-gigabyte file from Telegram through this app means every few
 * seconds of playback is a fresh ranged request, and on a weak link one of them
 * will eventually fail. The media element's answer to that is to fire `error`
 * and reset — which threw away the position and dropped the viewer at 0:00 with
 * a "couldn't load this file" card, twenty minutes into a film.
 *
 * So a network failure is treated as what it usually is: a stall. The position
 * is remembered, the element is reloaded and seeked straight back to it, and the
 * overlay says it is reconnecting. Buffering gets the same overlay rather than a
 * frozen frame, so "still working" never looks like "broken".
 *
 * Only a format the browser reports as unplayable becomes the failure card.
 * Running out of retries does not: that card unmounts the player, and unmounting
 * the player is precisely how someone ends up back at 0:00. The stage stays,
 * still holding the position, and offers to try again or download.
 */
const MAX_STREAM_RECOVERIES = 6;

/**
 * How long a stall has to last before the overlay stops saying "Buffering…" and
 * starts saying why.
 *
 * Measured against the real path: 16 MiB of a 975 MB video takes ~12 s to come
 * back out of Telegram, so a high-bitrate film genuinely outruns the pipe. A
 * spinner that never explains itself reads as a broken player; naming the cause
 * and offering the download turns it into a choice.
 */
const SLOW_AFTER_MS = 12_000;

/**
 * Playback speeds, and why there is no quality selector beside them.
 *
 * A quality menu needs renditions to choose between, and there is exactly one
 * file: the bytes the user uploaded. Building a 480p/720p ladder means ffmpeg
 * and CPU-minutes per file, which the free tier this runs on does not have, and
 * a "360p" entry that re-streams the same bytes would be a lie the buffering
 * would expose within seconds.
 *
 * Speed is the control that genuinely helps and costs nothing — it is a property
 * of the element, not of the stream. Slowing a high-bitrate film also hands
 * Telegram more wall-clock time per second of video, which is often the
 * difference between watching it and re-buffering through it.
 */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function VideoStage({
  src,
  fileId,
  onLoaded,
  onUnrecoverable,
  onDownload
}: {
  src: string;
  fileId: string;
  onLoaded: () => void;
  onUnrecoverable: () => void;
  onDownload: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "buffering" | "reconnecting" | "stalled">("buffering");
  const [slow, setSlow] = useState(false);
  const [speed, setSpeed] = useState(1);
  const recoveries = useRef(0);
  const resumeAt = useRef(0);

  // Re-applied rather than set once: `load()` on a recovery resets playbackRate
  // to 1, which would silently undo the viewer's choice every time the stream
  // hiccupped.
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed;
  }, [speed, state]);

  // A fresh file starts a fresh budget: recoveries spent on the last video must
  // not count against this one.
  useEffect(() => {
    recoveries.current = 0;
    resumeAt.current = 0;
    setSlow(false);
    setState("buffering");
  }, [fileId]);

  // "Buffering" that has gone on this long is not a blip, it is the bandwidth.
  useEffect(() => {
    if (state === "idle" || state === "stalled") {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  /** Reload and seek straight back to where the viewer was. */
  const resume = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setState("reconnecting");
    const wasPlaying = !el.paused;
    el.load();
    const seekBack = () => {
      // The whole point: `load()` puts the element back at 0, and this is what
      // stops that from being what the viewer sees.
      if (resumeAt.current > 0) el.currentTime = resumeAt.current;
      if (wasPlaying) void el.play().catch(() => {});
      el.removeEventListener("loadedmetadata", seekBack);
    };
    el.addEventListener("loadedmetadata", seekBack);
  }, []);

  const handleError = useCallback(() => {
    const el = ref.current;
    const code = el?.error?.code;
    // A format the browser cannot decode will fail identically every time, so
    // retrying it just spins. Only network/decode failures are worth another go.
    const recoverable =
      code === MediaError.MEDIA_ERR_NETWORK || code === MediaError.MEDIA_ERR_DECODE || code === undefined;

    // Not playable here at all — that is the one case worth replacing the player
    // with the "download instead" card.
    if (!el || !recoverable) {
      onUnrecoverable();
      return;
    }

    // Out of automatic retries. The player stays exactly where it is, holding
    // the remembered position, and the viewer decides whether to try again —
    // rather than being dropped back to 0:00 by a card that unmounts it.
    if (recoveries.current >= MAX_STREAM_RECOVERIES) {
      setState("stalled");
      return;
    }

    recoveries.current += 1;
    // Back off a little: hammering a link that just dropped a window rarely
    // helps, and the delay is invisible next to the stall the viewer already saw.
    setState("reconnecting");
    window.setTimeout(resume, 400 * recoveries.current);
  }, [onUnrecoverable, resume]);

  return (
    <div className="relative flex max-h-full max-w-full flex-col items-center justify-center gap-2">
      <video
        ref={ref}
        src={src}
        controls
        playsInline
        // Metadata up front so duration and the scrub bar work immediately;
        // seeking then issues Range requests against /api/stream.
        preload="metadata"
        onLoadedMetadata={() => {
          setState("idle");
          onLoaded();
        }}
        // The position is sampled continuously rather than read at failure time:
        // by the time `error` fires the element has often already reset it to 0.
        onTimeUpdate={event => {
          const time = (event.currentTarget as HTMLVideoElement).currentTime;
          if (time > 0) resumeAt.current = time;
        }}
        onWaiting={() => setState(s => (s === "reconnecting" || s === "stalled" ? s : "buffering"))}
        onStalled={() => setState(s => (s === "reconnecting" || s === "stalled" ? s : "buffering"))}
        onPlaying={() => {
          setState("idle");
          // Playback resumed, so whatever went wrong is behind us and the next
          // rough patch deserves a full budget of its own.
          recoveries.current = 0;
        }}
        onCanPlay={() => setState("idle")}
        onError={handleError}
        className="rounded-xl"
        style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", background: "#000" }}
      />

      {/* Below the frame, never over it — the browser's own controls live along
          the bottom edge and covering them is worse than any control we add. */}
      <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-1">
        <label className="flex items-center gap-1.5">
          <span className="mono" style={{ color: "var(--text-3)" }}>
            Speed
          </span>
          {/* A native select: keyboard- and screen-reader-correct for free, and
              it opens as the platform's own picker on a phone. */}
          <select
            value={speed}
            onChange={event => setSpeed(Number(event.target.value))}
            aria-label="Playback speed"
            className="mono rounded-md px-1.5 py-1"
            style={{ background: "var(--bg-1)", color: "var(--text-1)", border: "1px solid var(--border-med)" }}
          >
            {SPEEDS.map(value => (
              <option key={value} value={value}>
                {value}&times;
              </option>
            ))}
          </select>
        </label>
        {/* Offered from the start, not only once the stream has already given
            up: a high-bitrate film over a slow link is a choice worth having
            before twenty minutes of buffering, not after. */}
        <button
          onClick={onDownload}
          className="t-xs underline-offset-2 hover:underline"
          style={{ color: "var(--text-3)" }}
        >
          Having trouble? Download to play
        </button>
      </div>

      {state === "stalled" ? (
        <div
          className="absolute inset-x-0 top-3 mx-auto flex w-fit max-w-[92%] flex-col items-center gap-2 rounded-xl px-4 py-3 text-center"
          style={{ background: "rgba(4,6,12,0.88)", border: "1px solid var(--border-med)" }}
        >
          <span className="t-sm" style={{ color: "var(--text-2)" }}>
            The stream keeps dropping. Your place is kept — try again, or download it to watch offline.
          </span>
          <span className="flex gap-1.5">
            <button
              onClick={() => {
                recoveries.current = 0;
                resume();
              }}
              className="btn btn-accent"
              style={{ minHeight: 34, fontSize: 12 }}
            >
              Try again
            </button>
            <button onClick={onDownload} className="btn btn-ghost" style={{ minHeight: 34, fontSize: 12 }}>
              <Download className="h-3.5 w-3.5" /> Download
            </button>
          </span>
        </div>
      ) : state !== "idle" ? (
        <div
          className="absolute inset-x-0 top-3 mx-auto flex w-fit max-w-[92%] flex-col items-center gap-2 rounded-xl px-3 py-2 text-center"
          style={{ background: "rgba(4,6,12,0.78)", border: "1px solid var(--border-med)" }}
        >
          <span className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--accent)" }} />
            <span className="mono" style={{ color: "var(--text-2)" }}>
              {state === "reconnecting" ? "Reconnecting…" : "Buffering…"}
            </span>
          </span>
          {/* Still buffering, deliberately — the wait is explained rather than
              cut short, because cancelling would cost the viewer their place. */}
          {slow ? (
            <span className="t-xs" style={{ color: "var(--text-3)" }}>
              Telegram is feeding this slowly. Playback will continue — or download it to watch without the wait.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Full-bleed media viewer. Images and video stream through the app's proxy, so
 * a 2 GB video seeks via HTTP ranges rather than downloading first.
 */
export function Lightbox({
  file,
  allFiles,
  onClose,
  onNavigate,
  onDownload
}: {
  file: DriveFile;
  allFiles: DriveFile[];
  onClose: () => void;
  onNavigate: (file: DriveFile) => void;
  /** Routed through the app so the transfer joins the panel with the rest. */
  onDownload: (file: DriveFile) => void;
}) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const viewable = useMemo(() => allFiles.filter(f => isImage(f) || isVideo(f) || isAudio(f)), [allFiles]);
  const index = viewable.findIndex(f => f.id === file.id);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < viewable.length - 1;

  const go = useCallback(
    (delta: number) => {
      const next = viewable[index + delta];
      if (next) {
        setLoaded(false);
        setFailed(false);
        setZoomed(false);
        onNavigate(next);
      }
    },
    [index, viewable, onNavigate]
  );

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else onClose();
        return;
      }
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = previous;
    };
  }, [onClose, go, toggleFullscreen]);

  const image = isImage(file);
  const video = isVideo(file);
  const audio = isAudio(file);
  // Images come from /api/preview (cacheable); anything time-based streams from
  // /api/stream, which serves HTTP ranges so the player can seek.
  const src = image ? `/api/preview/${file.id}` : video || audio ? `/api/stream/${file.id}` : "";
  const Icon = image ? ImageIcon : video ? VideoIcon : audio ? Music : FileIcon;

  return (
    <motion.div
      ref={containerRef}
      {...fadeIn(reduceMotion)}
      className="fixed inset-0 z-[80] flex flex-col"
      style={{ background: "rgba(4,5,9,0.96)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={file.originalName}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid var(--border-dim)", paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="min-w-0">
          <p className="t-sm truncate font-semibold" style={{ color: "var(--text-1)" }}>{file.originalName}</p>
          <p className="mono truncate" style={{ color: "var(--text-3)" }}>
            {formatBytes(file.size)} · {file.mimeType || "file"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <a href={`/api/download/${file.id}`} className="btn btn-accent" aria-label="Download">
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download</span>
          </a>
          <button onClick={toggleFullscreen} className="icon-btn" aria-label="Toggle fullscreen" title="Fullscreen (F)">
            {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
          <button onClick={onClose} className="icon-btn icon-btn-danger" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Stage */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6"
        onClick={e => e.stopPropagation()}
        onTouchStart={e => {
          touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={e => {
          const start = touchStart.current;
          touchStart.current = null;
          if (!start || zoomed) return;
          const dx = e.changedTouches[0].clientX - start.x;
          const dy = e.changedTouches[0].clientY - start.y;
          // Horizontal intent only, so vertical scrolling still works.
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
        }}
      >
        {(image || video || audio) && !loaded && !failed ? (
          <Loader2 className="absolute h-7 w-7 animate-spin" style={{ color: "var(--accent)" }} />
        ) : null}

        {failed ? (
          <Unsupported
            icon={<Icon className="h-9 w-9" style={{ color: "var(--danger)" }} />}
            title="Couldn't load this file"
            body="The transfer failed or the format isn't playable in a browser. Downloading it will still work."
            onDownload={() => onDownload(file)}
          />
        ) : image ? (
          <img
            key={file.id}
            src={src}
            alt={file.originalName}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            onClick={() => setZoomed(z => !z)}
            className="rounded-xl"
            // Sized against the stage's own box rather than a percentage of a
            // scroll container, which is what produced the odd fitting before.
            style={
              zoomed
                ? { maxWidth: "none", maxHeight: "none", cursor: "zoom-out" }
                : {
                    maxWidth: "100%",
                    maxHeight: "100%",
                    width: "auto",
                    height: "auto",
                    objectFit: "contain",
                    cursor: "zoom-in"
                  }
            }
          />
        ) : video ? (
          <VideoStage
            key={file.id}
            src={src}
            fileId={file.id}
            onLoaded={() => setLoaded(true)}
            onUnrecoverable={() => setFailed(true)}
            onDownload={() => onDownload(file)}
          />
        ) : audio ? (
          <div className="w-full max-w-lg text-center">
            <span className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-2xl" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)" }}>
              <Music className="h-9 w-9" style={{ color: "var(--accent)" }} />
            </span>
            <audio
              key={file.id}
              src={src}
              controls
              preload="metadata"
              onLoadedMetadata={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className="w-full"
            />
          </div>
        ) : (
          <Unsupported
            icon={<Icon className="h-9 w-9" style={{ color: "var(--accent)" }} />}
            title="No inline preview"
            body={
              file.mimeType.includes("heic") || file.mimeType.includes("heif")
                ? "Browsers can't display HEIC/HEIF. Download it to view."
                : "This file type can't be shown in the browser."
            }
            onDownload={() => onDownload(file)}
          />
        )}

        {hasPrev ? (
          <button onClick={() => go(-1)} className="icon-btn absolute left-2 top-1/2 -translate-y-1/2" style={{ background: "var(--bg-1)", height: 44, width: 44 }} aria-label="Previous">
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}
        {hasNext ? (
          <button onClick={() => go(1)} className="icon-btn absolute right-2 top-1/2 -translate-y-1/2" style={{ background: "var(--bg-1)", height: 44, width: 44 }} aria-label="Next">
            <ChevronRight className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      {viewable.length > 1 ? (
        <div
          className="mono safe-bottom shrink-0 py-2 text-center"
          style={{ color: "var(--text-3)", borderTop: "1px solid var(--border-dim)" }}
          onClick={e => e.stopPropagation()}
        >
          {index + 1} / {viewable.length}
          <span className="hidden sm:inline"> · ← → navigate · F fullscreen</span>
          <span className="sm:hidden"> · swipe to browse</span>
        </div>
      ) : null}
    </motion.div>
  );
}
