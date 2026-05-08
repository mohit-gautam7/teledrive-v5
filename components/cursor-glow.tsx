"use client";
import { useEffect } from "react";

export function CursorGlow() {
  useEffect(() => {
    const el = document.getElementById("cursor-glow");
    if (!el) return;
    const move = (e: MouseEvent) => {
      el.style.left = e.clientX + "px";
      el.style.top = e.clientY + "px";
    };
    window.addEventListener("mousemove", move, { passive: true });
    return () => window.removeEventListener("mousemove", move);
  }, []);
  return <div id="cursor-glow" aria-hidden="true" />;
}
