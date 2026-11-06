"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "@/lib/motion";
import { DURATION_3D, EASE_3D, orbitEntrance, useTilt } from "@/lib/motion-3d";
import { cn } from "@/lib/utils";

/**
 * A card with depth: it arrives on an arc, and it leans towards the pointer.
 *
 * Two nested elements rather than one, and that is the whole trick. Framer
 * drives the entrance by writing `transform` into the outer element's style;
 * the tilt is CSS reading custom properties on the inner one. Put both on the
 * same node and the last writer wins — in practice the tilt is erased for the
 * duration of the entrance, then snaps in. Nested, they compose: the outer is
 * still unwinding its rotation while the inner already answers the pointer.
 *
 * The outer element carries no styling of its own and no padding, so callers
 * can keep passing `className` for the card's own look and nothing about the
 * layout changes.
 */
export function DepthCard({
  index,
  orbiting,
  className,
  children,
  style,
  ...rest
}: {
  /** Position in the grid. Decides where on the arc this one starts. */
  index: number;
  /** True while the folder that owns this grid is opening. */
  orbiting: boolean;
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "style">) {
  const reduce = useReducedMotion();
  const tilt = useTilt(!reduce);
  const entrance = orbitEntrance(index, Boolean(reduce));

  return (
    <motion.div
      // Only animate when a folder actually opened. Without this guard every
      // re-render — a rename, an upload landing, a selection — would replay the
      // arc, which is how motion stops meaning anything.
      initial={orbiting ? entrance.from : false}
      animate={entrance.to}
      transition={{ duration: DURATION_3D.orbit, ease: EASE_3D, delay: orbiting ? entrance.delay : 0 }}
      // Flattened the moment it lands. A node left with preserve-3d keeps its
      // own 3D rendering context for the rest of its life, which defeats the
      // single shared perspective on the stage above it.
      style={{ transformStyle: orbiting ? "preserve-3d" : "flat" }}
    >
      <div
        ref={tilt.ref as React.Ref<HTMLDivElement>}
        className={cn("tilt", className)}
        style={style}
        {...rest}
      >
        {children}
      </div>
    </motion.div>
  );
}
