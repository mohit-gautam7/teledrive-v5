"use client";

import { useSyncExternalStore } from "react";
import type { SortDir, SortField, ThemeMode } from "@/components/drive/types";

/**
 * Everything the user can decide about how the app looks and behaves.
 *
 * One object under one key, because the alternative — and what this replaces —
 * is a key per setting: `teledrive-theme` here, `teledrive-sidebar-width` there,
 * and the rest living only in component state and forgotten on every reload.
 * One object also means the pre-paint script in app/layout.tsx has one thing to
 * read, which is what keeps theme and accent from flashing.
 *
 * localStorage rather than a profile row: these are device preferences (a
 * sidebar width chosen on a 27" monitor is wrong on a laptop), they must be
 * readable before the first paint and before any request, and nothing here is
 * worth a round-trip. The one setting the server also needs — which backend to
 * store uploads in — is sent with the upload that needs it.
 */

export type UploadBackendPreference = "auto" | "account" | "bot";

export type Preferences = {
  theme: ThemeMode;
  accent: AccentName;
  /** Grid or list, applied to every browse view on load. */
  view: "grid" | "list";
  sortField: SortField;
  sortDir: SortDir;
  /** Files fetched per page, and therefore per infinite-scroll step. */
  pageSize: number;
  sidebarWidth: number;
  /** Force reduced motion even where the OS has not asked for it. */
  reduceMotion: boolean;
  uploadBackend: UploadBackendPreference;
};

export const PAGE_SIZES = [24, 48, 100];

/**
 * Sidebar width is bounded rather than free: narrower than the minimum and the
 * nav labels collapse into their icons, wider and the file grid loses a column
 * on a laptop.
 */
export const SIDEBAR_MIN = 208;
export const SIDEBAR_MAX = 460;
export const SIDEBAR_DEFAULT = 268;

/**
 * Accent pairs, each given twice.
 *
 * A hue that reads well on the near-black surface is washed out on the light
 * one, so every accent carries a light variant rather than being dimmed
 * programmatically. The rest of the palette (dim fill, border, gradient) is
 * derived with color-mix, which the stylesheet already relies on.
 */
export const ACCENTS = {
  cyan: { label: "Cyan", dark: ["#22d3ee", "#818cf8"], light: ["#0891b2", "#6366f1"] },
  violet: { label: "Violet", dark: ["#a78bfa", "#f472b6"], light: ["#7c3aed", "#db2777"] },
  emerald: { label: "Emerald", dark: ["#34d399", "#22d3ee"], light: ["#059669", "#0891b2"] },
  amber: { label: "Amber", dark: ["#fbbf24", "#fb7185"], light: ["#d97706", "#e11d48"] },
  rose: { label: "Rose", dark: ["#fb7185", "#a78bfa"], light: ["#e11d48", "#7c3aed"] },
  blue: { label: "Blue", dark: ["#60a5fa", "#22d3ee"], light: ["#2563eb", "#0891b2"] }
} as const;

export type AccentName = keyof typeof ACCENTS;

export const DEFAULTS: Preferences = {
  theme: "system",
  accent: "cyan",
  view: "grid",
  sortField: "date",
  sortDir: "desc",
  pageSize: 48,
  sidebarWidth: SIDEBAR_DEFAULT,
  reduceMotion: false,
  uploadBackend: "auto"
};

export const PREFS_KEY = "teledrive:prefs";
/** The single-purpose key this replaced; read once so nobody loses their theme. */
const LEGACY_THEME_KEY = "teledrive-theme";
const LEGACY_SIDEBAR_KEY = "teledrive-sidebar-width";

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/** Anything unrecognised falls back to its default rather than to undefined. */
export function normalise(raw: unknown): Preferences {
  const input = (raw ?? {}) as Partial<Preferences>;
  return {
    theme: ["light", "dark", "system"].includes(input.theme as string) ? (input.theme as ThemeMode) : DEFAULTS.theme,
    accent: input.accent && input.accent in ACCENTS ? input.accent : DEFAULTS.accent,
    view: input.view === "list" ? "list" : "grid",
    sortField: ["date", "name", "size"].includes(input.sortField as string)
      ? (input.sortField as SortField)
      : DEFAULTS.sortField,
    sortDir: input.sortDir === "asc" ? "asc" : "desc",
    pageSize: PAGE_SIZES.includes(Number(input.pageSize)) ? Number(input.pageSize) : DEFAULTS.pageSize,
    sidebarWidth: clamp(Number(input.sidebarWidth), SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT),
    reduceMotion: input.reduceMotion === true,
    uploadBackend: ["auto", "account", "bot"].includes(input.uploadBackend as string)
      ? (input.uploadBackend as UploadBackendPreference)
      : DEFAULTS.uploadBackend
  };
}

function read(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) return normalise(JSON.parse(raw));
    // First run after the upgrade: inherit what the old single-purpose keys held
    // so the app does not appear to forget the user's theme and sidebar.
    return normalise({
      theme: window.localStorage.getItem(LEGACY_THEME_KEY) as ThemeMode | null,
      sidebarWidth: Number(window.localStorage.getItem(LEGACY_SIDEBAR_KEY))
    });
  } catch {
    return DEFAULTS;
  }
}

// ── The store ────────────────────────────────────────────────────────────────

let current: Preferences = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function snapshot() {
  // Deferred to the first read so this module is importable on the server, and
  // so the first client snapshot matches the server's (no hydration mismatch).
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    current = read();
  }
  return current;
}

function serverSnapshot() {
  return DEFAULTS;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  snapshot();
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  persist();
  for (const listener of listeners) listener();
}

export function resetPreferences() {
  current = DEFAULTS;
  persist();
  for (const listener of listeners) listener();
}

function persist() {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(current));
  } catch {
    /* quota or private mode — the session keeps working, it just won't be remembered */
  }
}

/** The current settings outside React — the upload manager is not a component. */
export function readPreferences(): Preferences {
  return snapshot();
}

export function usePreferences() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * Paint the chosen accent onto the document.
 *
 * Inline custom properties on `:root` beat every stylesheet rule, so this is the
 * whole mechanism — no extra class, no per-accent stylesheet. It re-runs when the
 * theme changes because each accent carries a separate light variant.
 *
 * The pre-paint script in app/layout.tsx does the same thing from a copy of
 * ACCENTS, because it has to run before any module loads. That copy is the one
 * duplication here, and the alternative is a visible repaint on every visit.
 */
export function applyReducedMotion(reduce: boolean) {
  // An attribute rather than a class, so the CSS rule answering it reads as a
  // switch and cannot be mistaken for a style hook.
  const root = document.documentElement;
  if (reduce) root.setAttribute("data-reduce-motion", "1");
  else root.removeAttribute("data-reduce-motion");
}

export function applyAccent(accent: AccentName, dark: boolean) {
  const pair = ACCENTS[accent] ?? ACCENTS.cyan;
  const [one, two] = dark ? pair.dark : pair.light;
  const root = document.documentElement.style;
  root.setProperty("--accent", one);
  root.setProperty("--accent-2", two);
  root.setProperty("--accent-dim", `color-mix(in srgb, ${one} ${dark ? 10 : 9}%, transparent)`);
  root.setProperty("--accent-border", `color-mix(in srgb, ${one} ${dark ? 24 : 26}%, transparent)`);
  root.setProperty("--accent-grad", `linear-gradient(135deg, ${one} 0%, ${two} 100%)`);
}
