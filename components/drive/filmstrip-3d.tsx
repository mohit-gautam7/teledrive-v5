"use client";

import { useEffect, useMemo, useRef } from "react";
import { Film, Image as ImageIcon, Music } from "lucide-react";
import { useAssetUrl } from "@/lib/use-file-auth";
import { useReducedMotion } from "@/lib/motion";
import { DURATION_3D, EASE_3D } from "@/lib/motion-3d";
import { cn } from "@/lib/utils";
import type { DriveFile } from "./types";

/**
 * The curved rail of neighbours under the viewer.
 *
 * Everything the carousel needs is derived from one number — how far an item
 * sits from the one being viewed — so there is no per-item state to keep in
 * step and no animation to cancel when someone holds the arrow key down. Move
 * the index and every item re-derives its place on the curve.
 */

/** Items either side of centre that get rendered. */
const WINDOW = 5;
/** Horizontal gap between neighbours, in px, before the curve foreshortens it. */
const STEP = 76;
/** Rotation at the edge of the window. */
const MAX_TURN = 52;

function placeOnCurve(offset: number) {
  const side = Math.sign(offset);
  const distance = Math.min(Math.abs(offset), WINDOW);
  // Rotation saturates towards the edge so the far items read as a wall
  // turning away rather than as a fan opening ever wider.
  const turn = -side * MAX_TURN * (1 - Math.exp(-distance * 0.9));
  // Spacing compresses with distance: on a real curve the far items are both
  // further away and more side-on, so they occupy less width.
  const x = side * (STEP * distance - STEP * 0.22 * distance * distance * 0.14);
  const z = -90 * distance;
  return {
    transform: `translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(1)}px) rotateY(${turn.toFixed(1)}deg)`,
    // The centre item is fully lit; neighbours fall away. Past the window they
    // are not rendered at all, so this never reaches zero on a visible item.
    opacity: distance === 0 ? 1 : Math.max(0.25, 1 - distance * 0.18),
    zIndex: WINDOW - distance
  };
}

function Thumb({ file }: { file: DriveFile }) {
  const src = useAssetUrl(`/api/preview/${file.id}?thumb=1`);
  const isVideo = (file.mimeType || "").startsWith("video/");
  const isAudio = (file.mimeType || "").startsWith("audio/");
  const isImage = (file.mimeType || "").startsWith("image/");
  const Icon = isVideo ? Film : isAudio ? Music : ImageIcon;

  return (
    <>
      {isImage || isVideo ? (
        // Decoding async and loading lazily matters more here than in the
        // grid: the rail re-renders on every step, and a synchronous decode of
        // eleven thumbnails is a visible hitch on each arrow press.
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
          onError={event => {
            // A thumbnail Telegram will not serve must not leave a broken-image
            // glyph sitting in the rail; fall back to the type icon beneath.
            (event.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
      <span className="absolute inset-0 grid place-items-center" style={{ zIndex: -1 }}>
        <Icon className="h-5 w-5" style={{ color: "var(--text-3)" }} />
      </span>
    </>
  );
}

export function Filmstrip3D({
  files,
  currentId,
  onPick
}: {
  files: DriveFile[];
  currentId: string;
  onPick: (file: DriveFile) => void;
}) {
  const reduce = useReducedMotion();
  const railRef = useRef<HTMLDivElement>(null);
  const index = files.findIndex(f => f.id === currentId);

  // Only the window is rendered. A folder here can hold two thousand images,
  // and a rail that builds all of them is a rail that costs more than the
  // viewer it sits under.
  const shown = useMemo(() => {
    if (index < 0) return [];
    const from = Math.max(0, index - WINDOW);
    const to = Math.min(files.length, index + WINDOW + 1);
    return files.slice(from, to).map((file, i) => ({ file, offset: from + i - index }));
  }, [files, index]);

  // Keep the focused item reachable for screen readers and keyboard users even
  // though the visual order is a curve rather than a line.
  useEffect(() => {
    const node = railRef.current?.querySelector<HTMLElement>('[data-centre="true"]');
    node?.setAttribute("aria-current", "true");
  }, [currentId]);

  if (index < 0 || files.length < 2) return null;

  return (
    <div
      ref={railRef}
      className="relative shrink-0 select-none"
      style={{
        height: 104,
        // One perspective for the rail, so every item shares a vanishing point
        // and the row reads as one curved surface rather than as separate
        // cards each turning on its own axis.
        perspective: reduce ? undefined : 900,
        perspectiveOrigin: "50% 50%"
      }}
      onClick={event => event.stopPropagation()}
      role="listbox"
      aria-label="Media in this folder"
    >
      <div className="absolute inset-0 grid place-items-center" style={{ transformStyle: "preserve-3d" }}>
        {shown.map(({ file, offset }) => {
          const place = reduce
            ? { transform: `translate3d(${offset * STEP}px, 0, 0)`, opacity: offset === 0 ? 1 : 0.4, zIndex: WINDOW - Math.abs(offset) }
            : placeOnCurve(offset);
          const centre = offset === 0;
          return (
            <button
              key={file.id}
              type="button"
              role="option"
              aria-selected={centre}
              data-centre={centre || undefined}
              title={file.originalName}
              onClick={() => !centre && onPick(file)}
              className={cn(
                "absolute overflow-hidden rounded-lg",
                centre ? "cursor-default" : "cursor-pointer"
              )}
              style={{
                width: 72,
                height: 72,
                transform: place.transform,
                opacity: place.opacity,
                zIndex: place.zIndex,
                border: centre ? "2px solid var(--accent)" : "1px solid var(--border-dim)",
                background: "var(--bg-2)",
                boxShadow: centre ? "0 0 0 4px var(--accent-dim)" : undefined,
                transition: reduce
                  ? "none"
                  : `transform ${DURATION_3D.carousel}s cubic-bezier(${EASE_3D.join(",")}), opacity ${DURATION_3D.carousel}s ease`
              }}
            >
              <Thumb file={file} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
