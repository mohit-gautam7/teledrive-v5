"use client";

import { useReducedMotion, type Transition, type Variants } from "framer-motion";

/**
 * One motion vocabulary for the whole app.
 *
 * Before this, every component invented its own durations and easings — 0.15s
 * here, 0.32s there, three different cubic-béziers — so the app moved like
 * several apps stitched together. These are the only values anything should
 * reach for.
 *
 * Two rules underpin the numbers:
 *
 *  - Only `opacity` and `transform` are animated. Those are the two properties
 *    the compositor can handle without laying out or painting a frame, which is
 *    what keeps this at 60fps on a phone. Animating width, height, top or left
 *    forces layout on every frame and drags in everything around it.
 *  - Nothing animates in a way that moves its neighbours. Entrances travel a few
 *    pixels along an axis the element already occupies, so a list settling in
 *    never reflows the page under the pointer.
 */

/** Standard ease-out. Fast to start, gentle to stop — reads as responsive. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export const DURATION = {
  /** Hovers, presses, colour changes. Below ~120ms reads as instant. */
  fast: 0.16,
  /** The default: entrances, exits, view changes. */
  base: 0.24,
  /** Anything crossing a large distance, like a full-screen overlay. */
  slow: 0.32
} as const;

/** For things that should feel physical — bars that fly in, rails that slide. */
export const SPRING: Transition = { type: "spring", stiffness: 420, damping: 34 };

export const transition: Transition = { duration: DURATION.base, ease: EASE };

/**
 * Motion presets, each returning props to spread onto a `motion` element.
 *
 * Every one takes `reduce`: with prefers-reduced-motion the movement is dropped
 * and only opacity remains. That is deliberate rather than disabling animation
 * outright — a cross-fade still communicates that something changed, without the
 * travel that causes trouble for people who asked for less of it.
 */
export function fadeUp(reduce: boolean | null, distance = 8, delay = 0) {
  return {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: distance },
    animate: { opacity: 1, y: 0 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, y: distance },
    transition: { ...transition, delay }
  };
}

export function fadeIn(reduce: boolean | null, delay = 0) {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduce ? DURATION.fast : DURATION.base, ease: EASE, delay }
  };
}

/** A card or tile arriving in a grid: rises slightly and scales back to rest. */
export function popIn(reduce: boolean | null, delay = 0) {
  return {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 },
    transition: { ...transition, delay }
  };
}

/** A panel that slides up from the bottom edge — bulk bar, sheets. */
export function riseFromBottom(reduce: boolean | null) {
  return {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 70 },
    animate: { opacity: 1, y: 0 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, y: 70 },
    transition: reduce ? transition : SPRING
  };
}

/**
 * Stagger for a list, capped.
 *
 * Uncapped, the fortieth tile in a folder waits most of a second before it
 * appears — the effect stops reading as polish and starts reading as slowness.
 */
export function stagger(index: number, step = 0.018, cap = 0.16) {
  return Math.min(index * step, cap);
}

/** Hover and press feedback, transform-only. */
export const pressable = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.97 },
  transition: { duration: DURATION.fast, ease: EASE }
} as const;

/** Container/child variants for a list that should settle in sequence. */
export const listContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03 } }
};

export const listChild: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition }
};

/** `useReducedMotion` with a name that reads the way it is used. */
export function useMotionPreference() {
  return useReducedMotion();
}
