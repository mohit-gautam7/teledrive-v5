"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  Image as ImageIcon,
  Loader2,
  Maximize,
  Minimize,
  Video as VideoIcon,
  X
} from "lucide-react";
import { formatBytes } from "@/lib/utils";
import type { DriveFile } from "./types";

const isImage = (f: DriveFile) =>
  f.mimeType.startsWith("image/") && !f.mimeType.includes("heic") && !f.mimeType.includes("heif");
const isVideo = (f: DriveFile) => f.mimeType.startsWith("video/");

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
  const [zoomed, setZoomed] = useState(false);

  const viewable = useMemo(() => allFiles.filter(f => isImage(f) || isVideo(f)), [allFiles]);
  const index = viewable.findIndex(f => f.id === file.id);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < viewable.length - 1;

  const go = useCallback(
    (delta: number) => {
      const next = viewable[index + delta];
      if (next) {
        setLoaded(false);
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
  const src = image ? `/api/preview/${file.id}` : video ? `/api/stream/${file.id}` : "";
  const Icon = image ? ImageIcon : video ? VideoIcon : FileIcon;

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
        {image && !loaded ? <Loader2 className="absolute h-7 w-7 animate-spin" style={{ color: "var(--accent)" }} /> : null}

        <AnimatePresence mode="wait">
          {image ? (
            <motion.img
              key={file.id}
              src={src}
              alt={file.originalName}
              initial={{ opacity: 0, scale: 0.97 }}
              // Opacity is never gated on load state: an image that finishes
              // before React attaches onLoad would otherwise stay invisible
              // forever. The browser paints nothing until bytes arrive anyway,
              // and the spinner underneath covers the gap.
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(true)}
              onClick={() => setZoomed(z => !z)}
              className="rounded-xl"
              style={{
                maxWidth: zoomed ? "none" : "100%",
                maxHeight: zoomed ? "none" : "100%",
                width: zoomed ? "auto" : undefined,
                objectFit: "contain",
                cursor: zoomed ? "zoom-out" : "zoom-in",
                position: "relative"
              }}
            />
          ) : video ? (
            <motion.video
              key={file.id}
              src={src}
              controls
              autoPlay
              playsInline
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="rounded-xl"
              style={{ maxWidth: "100%", maxHeight: "100%" }}
            />
          ) : (
            <motion.div key={file.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center">
              <span className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-2xl" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)" }}>
                <Icon className="h-9 w-9" style={{ color: "var(--accent)" }} />
              </span>
              <p className="t-body font-semibold" style={{ color: "var(--text-2)" }}>No inline preview</p>
              <p className="t-sm mt-1" style={{ color: "var(--text-3)" }}>
                {file.mimeType.includes("heic") || file.mimeType.includes("heif")
                  ? "Browsers can't display HEIC/HEIF. Download to view."
                  : "Download the file to open it."}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

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
