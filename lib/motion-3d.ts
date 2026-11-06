"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The depth half of the motion system.
 *
 * `lib/motion.ts` governs everything flat — entrances, exits, hovers. This
 * governs the three places where depth earns its cost:
 *
 *   1. Opening a folder, which arrives on an arc instead of appearing.
 *   2. The media viewer, where neighbouring items sit on a curve.
 *   3. Tiles under the pointer, which tilt towards it.
 *
 * Everything else stays flat on purpose. This is a drive with 9,298 files in
 * it: a folder of two thousand tiles each running its own transform is a
 * dropped-frame machine, and a file manager that is beautiful but stutters
 * while you look for a document is a worse tool than a plain one. So the rules
 * below are not stylistic preferences, they are what keeps it usable:
 *
 *   - Only `transform` and `opacity` animate. Both are composited; neither
 *     lays out or paints.
 *   - Depth is applied to a bounded window of items (ORBIT_MAX), never the
 *     whole list. Past that, items cross-fade with no transform at all.
 *   - `perspective` lives on one parent, not per element. A perspective per
 *     tile means a stacking context per tile.
 *   - Every effect here collapses to a fade when the user asked for less
 *     motion, and the tilt turns itself off entirely on touch.
 */

/**
 * Expo-out. Leaves fast, lands slowly, and holds the landing — which is what
 * reads as weight rather than speed. The flat system's EASE is gentler; a
 * rotation needs the harder deceleration or it looks like it is sliding on ice.
 */
export const EASE_3D = [0.16, 1, 0.3, 1] as const;

export const DURATION_3D = {
  /** The arc a folder's contents travel on open. */
  orbit: 0.62,
  /** One step of the media viewer's carousel. */
  carousel: 0.44,
  /** Tilt settling back to flat when the pointer leaves. */
  settle: 0.4
} as const;

/**
 * How many tiles get the orbital entrance.
 *
 * Roughly two screens' worth. Past this the arc is invisible anyway — the item
 * is below the fold before it lands — so it buys nothing and costs a composited
 * layer. Items beyond it fade in flat.
 */
export const ORBIT_MAX = 24;

/** Degrees of rotation the first tile starts at. Later ones start shallower. */
const ORBIT_SWEEP = 34;
/** How far back along Z the arc starts, in pixels. */
const ORBIT_DEPTH = 240;

/**
 * The starting transform for tile `index` in a folder that is opening.
 *
 * Tiles are treated as points on a cylinder whose axis is the left edge of the
 * grid: the further along the list, the further round the curve it starts, up
 * to a cap. They unwind to flat together, so the grid assembles itself out of
 * depth rather than fading up as a sheet.
 *
 * Returned as a style object rather than a class because the angle is per
 * index, and a stylesheet cannot hold 24 variants without being worse than this.
 */
export function orbitEntrance(index: number, reduce: boolean) {
  if (reduce || index >= ORBIT_MAX) {
    return { from: { opacity: 0 }, to: { opacity: 1 }, delay: 0 };
  }
  // Ease the angle off with distance so the near tiles carry the gesture and
  // the far ones do not whip.
  const t = index / ORBIT_MAX;
  const angle = ORBIT_SWEEP * (1 - t * 0.72);
  const depth = ORBIT_DEPTH * (1 - t * 0.55);
  return {
    from: { opacity: 0, rotateY: angle, z: -depth, x: depth * 0.18 },
    to: { opacity: 1, rotateY: 0, z: 0, x: 0 },
    // 26ms apart: close enough to read as one movement, far enough apart to
    // see the curve. 45ms (the flat system's stagger) reads as a queue.
    delay: index * 0.026
  };
}

/**
 * Pointer-tracked tilt for a card.
 *
 * The transform is written inline, onto the node, by hand. That looks like the
 * wrong place for it until you try the alternative: `.tilt { transform: ... }`
 * in the stylesheet loses to framer-motion, which writes `transform` inline on
 * every element it animates (and writes `none` when the animation settles).
 * Inline beats a stylesheet rule, so the CSS version silently never applied on
 * a motion element. Writing it here means one mechanism that works whether or
 * not framer owns the node.
 *
 * React still never re-renders on pointer move — this touches the DOM node
 * directly, once per frame, and the compositor does the rest.
 *
 * Off for touch and for reduced motion. A tilt that fires on tap is a tile that
 * looks broken when you are trying to press it.
 */
export function useTilt(enabled: boolean, maxDeg = 7) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;

    let frame: number | null = null;
    let live = false;

    const write = (px: number, py: number) => {
      // Y rotation follows horizontal travel, X inverts vertical travel, so the
      // tile leans towards the cursor rather than away from it.
      const ry = (px * maxDeg * 2).toFixed(2);
      const rx = (-py * maxDeg * 2).toFixed(2);
      node.style.transform =
        `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translate3d(0, -6px, 0)`;
      node.style.setProperty("--sheen", `${((px + 0.5) * 100).toFixed(1)}%`);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      live = true;
      const rect = node.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        // The frame can still be dequeued after the pointer left, which used to
        // leave the tile stuck mid-tilt with nothing to un-stick it.
        if (!live) return;
        write(px, py);
      });
    };

    const onLeave = () => {
      live = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      // Cleared rather than set to an identity transform: an element left with
      // any transform keeps its own containing block and compositing layer for
      // good, and a grid of those is the cost this file exists to avoid.
      node.style.transform = "";
      node.style.setProperty("--sheen", "-20%");
    };

    // Native listeners, not React's.
    //
    // React batches pointermove through its synthetic event system, and
    // measured here that lag ran past 120ms — far enough behind the cursor to
    // read as the tile sticking rather than tracking. `passive` because this
    // never calls preventDefault, which lets the browser keep the move off the
    // main thread's critical path.
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerleave", onLeave, { passive: true });
    node.addEventListener("pointercancel", onLeave, { passive: true });
    node.addEventListener("blur", onLeave);

    return () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", onLeave);
      node.removeEventListener("pointercancel", onLeave);
      node.removeEventListener("blur", onLeave);
      if (frame !== null) cancelAnimationFrame(frame);
      node.style.transform = "";
    };
  }, [enabled, maxDeg]);

  return { ref };
}

/**
 * True for one orbit's duration each time `key` changes.
 *
 * Drives the folder-open arc: the grid re-keys on the folder id, this flips on,
 * and the tiles mount with their entrance. It flips off afterwards so that a
 * later re-render — a rename, a selection, an upload finishing — does not
 * replay the whole arc. Re-animating a grid because one filename changed is the
 * thing that makes motion feel cheap.
 */
export function useOrbitOnChange(key: string | null) {
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  const [orbiting, setOrbiting] = useState(false);

  // Adjusted during render, not in an effect, and that is the whole point.
  // An effect runs *after* children have mounted, so by the time it flipped the
  // flag the tiles had already read `false` and committed to the flat
  // entrance — the arc never ran. React re-renders immediately on a state set
  // during render, before committing children, so this way the grid's tiles
  // see `true` on their very first render.
  if (seen !== key) {
    const firstEver = seen === undefined;
    setSeen(key);
    // Arriving at a URL is not a navigation the user performed; only animate
    // once they have actually opened something.
    if (!firstEver && !orbiting) setOrbiting(true);
  }

  useEffect(() => {
    if (!orbiting) return;
    const until = window.setTimeout(
      () => setOrbiting(false),
      (DURATION_3D.orbit + ORBIT_MAX * 0.026) * 1000
    );
    return () => window.clearTimeout(until);
  }, [orbiting]);

  return orbiting;
}
