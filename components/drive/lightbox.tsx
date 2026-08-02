"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
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
  fileId
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  fileId: string;
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
      <a href={`/api/download/${fileId}`} className="btn btn-accent mt-5">
        <Download className="h-4 w-4" /> Download
      </a>
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
  onNavigate
}: {
  file: DriveFile;
  allFiles: DriveFile[];
  onClose: () => void;
  onNavigate: (file: DriveFile) => void;
}) {
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
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
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
            fileId={file.id}
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
          <video
            key={file.id}
            src={src}
            controls
            playsInline
            // Metadata up front so duration and the scrub bar work immediately;
            // seeking then issues Range requests against /api/stream.
            preload="metadata"
            onLoadedMetadata={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className="rounded-xl"
            style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", background: "#000" }}
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
            fileId={file.id}
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
