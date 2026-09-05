"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Check,
  Clock,
  Copy,
  Folder as FolderIcon,
  Link2,
  Loader2,
  Lock,
  Mail,
  Monitor,
  Moon,
  Plus,
  Power,
  RefreshCw,
  Smartphone,
  RotateCcw,
  Sun,
  Trash2,
  Unlink
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatBytes } from "@/lib/utils";
import { CHUNK_SIZE, MAX_FILE_SIZE, BOT_DOWNLOAD_LIMIT } from "@/lib/upload-config";
import {
  ACCENTS,
  PAGE_SIZES,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  resetPreferences,
  setPreference,
  usePreferences,
  type AccentName
} from "@/lib/preferences";
import { DURATION, EASE, fadeUp, stagger, useReducedMotion } from "@/lib/motion";
import type { AiKeyRow, AiProvider, AiUsage, Insights, ShareRow, SortField, TelegramLink, ThemeMode } from "./types";

// ── Shared view ─────────────────────────────────────────────────────────────

export function SharesPanel() {
  const reduceMotion = useReducedMotion();
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ shares: ShareRow[] }>("/api/share")
      .then(d => setShares(d.shares))
      .catch(() => {
        setShares([]);
        toast.error("Could not load your share links.");
      });
  }, []);
  useEffect(load, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      await apiFetch(`/api/share/manage/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the link.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    try {
      await apiFetch(`/api/share/manage/${id}`, { method: "DELETE" });
      setShares(rows => rows?.filter(r => r.id !== id) ?? null);
      toast.success("Link revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke the link.");
    } finally {
      setBusy(null);
    }
  }

  if (!shares) return <PanelSkeleton rows={3} />;

  if (!shares.length) {
    return (
      <EmptyState
        icon={<Link2 className="h-7 w-7" style={{ color: "var(--accent)" }} />}
        title="No share links yet"
        body="Create one from any file or folder — you'll be able to password-protect, expire and revoke it here."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {shares.map((share, i) => (
        <motion.div key={share.id} {...fadeUp(reduceMotion, 10, stagger(i))} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: "var(--surface)" }}>
                {share.kind === "folder" ? (
                  <FolderIcon className="h-4 w-4" style={{ color: "var(--accent-2)" }} />
                ) : (
                  <Link2 className="h-4 w-4" style={{ color: "var(--accent)" }} />
                )}
              </span>
              <div className="min-w-0">
                <p className="t-sm truncate font-semibold" style={{ color: "var(--text-1)" }}>{share.name}</p>
                <p className="mono truncate" style={{ color: "var(--text-3)" }}>
                  {share.size !== null ? `${formatBytes(share.size)} · ` : ""}
                  {new Date(share.createdAt).toLocaleDateString()}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {share.disabled ? <Tag tone="danger">Disabled</Tag> : share.expired ? <Tag tone="danger">Expired</Tag> : <Tag tone="ok">Active</Tag>}
                  {share.hasPassword ? (
                    <Tag>
                      <Lock className="h-3 w-3" /> Password
                    </Tag>
                  ) : null}
                  {share.expiryDate ? (
                    <Tag>
                      <Clock className="h-3 w-3" /> {new Date(share.expiryDate).toLocaleDateString()}
                    </Tag>
                  ) : null}
                  {share.orphaned ? <Tag tone="danger">File deleted</Tag> : null}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}${share.url}`);
                  toast.success("Link copied");
                }}
                className="icon-btn"
                aria-label="Copy link"
                title="Copy link"
              >
                <Copy className="h-4 w-4" />
              </button>
              <button
                onClick={() => patch(share.id, { disabled: !share.disabled })}
                disabled={busy === share.id}
                className="icon-btn"
                aria-label={share.disabled ? "Enable link" : "Disable link"}
                title={share.disabled ? "Enable" : "Disable"}
              >
                {busy === share.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              </button>
              <button onClick={() => revoke(share.id)} disabled={busy === share.id} className="icon-btn icon-btn-danger" aria-label="Revoke link" title="Revoke">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Password + expiry editing, inline */}
          <div className="mt-3 flex flex-wrap gap-1.5" style={{ borderTop: "1px solid var(--border-dim)", paddingTop: 12 }}>
            {([[0, "No expiry"], [1, "1 day"], [7, "7 days"], [30, "30 days"]] as Array<[number, string]>).map(([days, label]) => (
              <button
                key={days}
                onClick={() =>
                  patch(share.id, { expiryDate: days ? new Date(Date.now() + days * 86400_000).toISOString() : null })
                }
                disabled={busy === share.id}
                className="btn btn-ghost"
                style={{ minHeight: 32, fontSize: 12 }}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => {
                const next = window.prompt(share.hasPassword ? "New password (blank removes it)" : "Set a password (min 4 characters)");
                if (next === null) return;
                if (next && next.length < 4) {
                  toast.error("Password must be at least 4 characters.");
                  return;
                }
                patch(share.id, { password: next || null });
              }}
              disabled={busy === share.id}
              className="btn btn-ghost"
              style={{ minHeight: 32, fontSize: 12 }}
            >
              <Lock className="h-3 w-3" /> {share.hasPassword ? "Change password" : "Add password"}
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ── Storage insights ────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  image: "var(--accent)",
  video: "var(--accent-2)",
  audio: "var(--emerald)",
  document: "var(--amber)"
};

export function InsightsPanel({
  insights,
  user,
  onOpenFile
}: {
  insights: Insights | null;
  /** Shown as the header of the stats view when it is opened from the profile. */
  user?: { name: string; username?: string | null };
  onOpenFile: (id: string) => void;
}) {
  // Before the early return — a hook cannot sit behind a conditional.
  const reduceMotion = useReducedMotion();

  // The sidebar's cheap stats call only fills totalSize/count; wait for the
  // full breakdown before drawing the charts.
  if (!insights?.byType || !insights.byBackend || !insights.largest) return <PanelSkeleton rows={2} />;

  const total = insights.byType.reduce((sum, t) => sum + t.bytes, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {user ? (
        <section className="panel flex items-center gap-4 p-5 lg:col-span-2">
          <span
            className="grid h-14 w-14 shrink-0 place-items-center rounded-full text-xl font-bold"
            style={{ background: "var(--accent-grad)", color: "#04070c" }}
          >
            {user.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="display truncate t-h2">{user.name}</p>
            <p className="mono truncate" style={{ color: "var(--text-3)" }}>
              {user.username ? `@${user.username}` : "Telegram"}
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel p-5 lg:col-span-2">
        <p className="eyebrow">Total stored</p>
        <p className="display mt-1" style={{ fontSize: "clamp(2rem,6vw,3rem)" }}>{formatBytes(insights.totalSize)}</p>
        <p className="t-sm mt-1" style={{ color: "var(--text-2)" }}>
          {insights.count} file{insights.count === 1 ? "" : "s"}
          {insights.folderCount !== undefined
            ? ` · ${insights.folderCount} folder${insights.folderCount === 1 ? "" : "s"}`
            : ""}
          {insights.trashCount ? ` · ${formatBytes(insights.trashSize)} recoverable in trash` : ""}
        </p>

        {total > 0 ? (
          <>
            {/* Each segment is laid out at its final width and grows in with
                scaleX. Animating `width` instead — which is what this did — put
                every sibling through layout on every frame of a 0.7 s animation,
                for a bar that is on screen the moment the panel opens. */}
            <div className="mt-5 flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface)" }}>
              {insights.byType.map(t => (
                <motion.span
                  key={t.bucket}
                  initial={reduceMotion ? { opacity: 0 } : { scaleX: 0 }}
                  animate={reduceMotion ? { opacity: 1 } : { scaleX: 1 }}
                  transition={{ duration: reduceMotion ? DURATION.fast : DURATION.slow, ease: EASE }}
                  style={{
                    width: `${(t.bytes / total) * 100}%`,
                    transformOrigin: "left center",
                    background: TYPE_COLORS[t.bucket] || "var(--text-3)"
                  }}
                  title={`${t.bucket}: ${formatBytes(t.bytes)}`}
                />
              ))}
            </div>
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
              {insights.byType.map(t => (
                <li key={t.bucket} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_COLORS[t.bucket] || "var(--text-3)" }} />
                  <span className="t-sm capitalize" style={{ color: "var(--text-1)" }}>{t.bucket}</span>
                  <span className="mono" style={{ color: "var(--text-3)" }}>{formatBytes(t.bytes)} · {t.files}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel p-5">
        <p className="eyebrow">Where it lives</p>
        <ul className="mt-3 space-y-2.5">
          {insights.byBackend.length === 0 ? (
            <li className="t-sm" style={{ color: "var(--text-3)" }}>Nothing stored yet.</li>
          ) : (
            insights.byBackend.map(b => (
              <li key={b.backend} className="flex items-center justify-between gap-3">
                <span className="t-sm" style={{ color: "var(--text-1)" }}>
                  {b.backend === "mtproto" ? "Your Telegram account" : "Bot chat (chunked)"}
                </span>
                <span className="mono" style={{ color: "var(--text-3)" }}>{formatBytes(b.bytes)} · {b.files}</span>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="panel p-5">
        <p className="eyebrow">Largest files</p>
        <ul className="mt-3 space-y-2">
          {insights.largest.length === 0 ? (
            <li className="t-sm" style={{ color: "var(--text-3)" }}>Nothing stored yet.</li>
          ) : (
            insights.largest.map(f => (
              <li key={f.id}>
                <button onClick={() => onOpenFile(f.id)} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-[var(--surface)]">
                  <span className="t-sm truncate" style={{ color: "var(--text-1)" }}>{f.originalName}</span>
                  <span className="mono shrink-0" style={{ color: "var(--text-3)" }}>{formatBytes(f.size)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

/** A labelled row of mutually exclusive choices — the shape most settings take. */
function Choice<T extends string | number>({
  label,
  hint,
  value,
  options,
  onChange
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: typeof Sun }>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      {hint ? (
        <p className="t-xs mt-0.5 leading-snug" style={{ color: "var(--text-3)" }}>
          {hint}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map(option => (
          <button
            key={String(option.value)}
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={value === option.value ? "btn btn-accent" : "btn btn-ghost"}
            style={{ minHeight: 40 }}
          >
            {option.icon ? <option.icon className="h-4 w-4" /> : null}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Everything the user can decide, in one place.
 *
 * Settings that used to be scattered — a theme in its own storage key, a sidebar
 * width in another, a view mode and a sort order that reset on every reload —
 * are all one object now (lib/preferences.ts), so anything added here is
 * remembered by the same mechanism without new plumbing.
 */
export function SettingsPanel({ link, onLinkChanged }: { link: TelegramLink | null; onLinkChanged: () => void }) {
  const prefs = usePreferences();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel space-y-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="display t-h2">Appearance</h2>
          <button
            onClick={() => {
              resetPreferences();
              toast.success("Settings reset. Reload to apply the layout defaults.");
            }}
            className="btn btn-ghost"
            style={{ minHeight: 34, fontSize: 12 }}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
        </div>

        <Choice<ThemeMode>
          label="Theme"
          value={prefs.theme}
          onChange={value => setPreference("theme", value)}
          options={[
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
            { value: "system", label: "System", icon: Monitor }
          ]}
        />

        <div>
          <p className="eyebrow">Accent</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(Object.keys(ACCENTS) as AccentName[]).map(name => (
              <button
                key={name}
                onClick={() => setPreference("accent", name)}
                aria-pressed={prefs.accent === name}
                aria-label={ACCENTS[name].label}
                title={ACCENTS[name].label}
                className="h-9 w-9 rounded-full transition"
                style={{
                  background: `linear-gradient(135deg, ${ACCENTS[name].dark[0]} 0%, ${ACCENTS[name].dark[1]} 100%)`,
                  outline: prefs.accent === name ? "2px solid var(--text-1)" : "1px solid var(--border-dim)",
                  outlineOffset: 2
                }}
              />
            ))}
          </div>
        </div>

        <Choice
          label="Motion"
          hint="Your system setting already switches this on; this forces it regardless."
          value={prefs.reduceMotion ? "reduced" : "full"}
          onChange={value => setPreference("reduceMotion", value === "reduced")}
          options={[
            { value: "full", label: "Full motion" },
            { value: "reduced", label: "Reduced" }
          ]}
        />

        <div>
          <p className="eyebrow">Sidebar width</p>
          <div className="mt-2 flex items-center gap-3">
            <input
              type="range"
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              step={4}
              value={prefs.sidebarWidth}
              onChange={event => setPreference("sidebarWidth", Number(event.target.value))}
              aria-label="Sidebar width"
              className="w-full"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="mono shrink-0" style={{ color: "var(--text-3)" }}>
              {prefs.sidebarWidth}px
            </span>
          </div>
          <p className="t-xs mt-1" style={{ color: "var(--text-3)" }}>
            Takes effect on the next load — drag the sidebar edge to change it now.
          </p>
        </div>
      </section>

      <section className="panel space-y-5 p-5">
        <h2 className="display t-h2">Drive defaults</h2>
        <p className="t-sm -mt-3 leading-relaxed" style={{ color: "var(--text-3)" }}>
          Where the drive starts each visit. The toolbar still overrides any of them for the session.
        </p>

        <Choice<"grid" | "list">
          label="Default view"
          value={prefs.view}
          onChange={value => setPreference("view", value)}
          options={[
            { value: "grid", label: "Grid" },
            { value: "list", label: "List" }
          ]}
        />

        <Choice<SortField>
          label="Default sort"
          value={prefs.sortField}
          onChange={value => {
            setPreference("sortField", value);
            // Names read best A→Z; dates and sizes read best largest-first.
            setPreference("sortDir", value === "name" ? "asc" : "desc");
          }}
          options={[
            { value: "date", label: "Date" },
            { value: "name", label: "Name" },
            { value: "size", label: "Size" }
          ]}
        />

        <Choice<"asc" | "desc">
          label="Sort direction"
          value={prefs.sortDir}
          onChange={value => setPreference("sortDir", value)}
          options={[
            { value: "desc", label: "Descending" },
            { value: "asc", label: "Ascending" }
          ]}
        />

        <Choice<number>
          label="Items per page"
          hint="How many files each scroll step loads."
          value={prefs.pageSize}
          onChange={value => setPreference("pageSize", value)}
          options={PAGE_SIZES.map(size => ({ value: size, label: String(size) }))}
        />
      </section>

      <TelegramLinkCard link={link} onChanged={onLinkChanged} />

      <section className="panel p-5">
        <h2 className="display t-h2">Upload storage</h2>
        <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-3)" }}>
          {link?.linked
            ? `Anything over ${formatBytes(BOT_DOWNLOAD_LIMIT)} is stored in your own Telegram account as a single message, because that is the largest document a bot can serve back. You can override that.`
            : "Link your Telegram account above to store big files as one message instead of hundreds of bot chunks."}
        </p>
        <div className={link?.linked ? "mt-4" : "mt-4 opacity-50"}>
          <Choice
            label="Default backend"
            value={prefs.uploadBackend}
            onChange={value => setPreference("uploadBackend", value)}
            options={[
              { value: "auto" as const, label: "Automatic" },
              { value: "account" as const, label: "Always my account" },
              { value: "bot" as const, label: "Always the bot" }
            ]}
          />
          {!link?.linked ? (
            <p className="t-xs mt-2" style={{ color: "var(--text-3)" }}>
              Ignored until an account is linked — the bot is the only storage there is.
            </p>
          ) : null}
        </div>
      </section>

      <AiSection />

      <section className="panel p-5 lg:col-span-2">
        <h2 className="display t-h2">Limits</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["Minimum file size", "1 byte"],
            ["Maximum file size", formatBytes(link?.maxBytes ?? MAX_FILE_SIZE)],
            ["Upload chunk", formatBytes(CHUNK_SIZE)]
          ].map(([label, value]) => (
            <li key={label} className="rounded-xl p-3.5" style={{ background: "var(--surface)" }}>
              <p className="eyebrow">{label}</p>
              <p className="t-body mt-1 font-semibold" style={{ color: "var(--text-1)" }}>{value}</p>
            </li>
          ))}
        </ul>
        <p className="t-sm mt-3 leading-relaxed" style={{ color: "var(--text-3)" }}>
          Telegram sets these ceilings, not TeleDrive. Bot storage chunks every file so no piece exceeds the Bot
          API&apos;s {formatBytes(BOT_DOWNLOAD_LIMIT)} download limit; linking your own account stores big files as a
          single message instead.
        </p>
      </section>
    </div>
  );
}


/**
 * One request for the whole AI section.
 *
 * The four cards below are independent components but must not each fetch: four
 * concurrent calls serialise behind the pooler's single connection, and the card
 * that lost the race rendered blank. `AiSection` makes the one call and hands
 * each card what it needs, so they mount already populated instead of each
 * flickering through its own empty state.
 *
 * `reloadAiOverview()` after a mutation drops the cached promise so the next
 * read is fresh.
 */
export type AiOverview = {
  providers: AiProvider[];
  keys: AiKeyRow[];
  preferences: { mode: string; strategy: string; taskOverrides: Record<string, { mode?: string }> };
  modes: string[];
  automations: AutomationRow[];
  usage: AiUsage;
};

let aiOverviewPromise: Promise<AiOverview> | null = null;

/**
 * A busy database is not an answer, so ask again before believing it.
 *
 * The server marks "the pooler had nothing to give" as 503, which is precisely
 * the failure that used to make this section disappear behind a toast. Two quick
 * retries turn it into a slightly longer skeleton. A 404 (the feature is off)
 * and a 401 are final and returned immediately.
 */
async function fetchAiOverview(attempts = 3): Promise<AiOverview> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await apiFetch<AiOverview>("/api/ai/overview");
    } catch (err) {
      const retryable = err instanceof ApiError && err.status >= 500;
      if (!retryable || attempt >= attempts) throw err;
      await new Promise(resolve => setTimeout(resolve, 400 * attempt));
    }
  }
}

function loadAiOverview(): Promise<AiOverview> {
  if (!aiOverviewPromise) {
    aiOverviewPromise = fetchAiOverview().catch(err => {
      // A failed attempt must not be cached, or every card retries nothing.
      aiOverviewPromise = null;
      throw err;
    });
  }
  return aiOverviewPromise;
}

function reloadAiOverview(): Promise<AiOverview> {
  aiOverviewPromise = null;
  return loadAiOverview();
}

type AutomationRow = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { event: string; mimePrefix?: string; nameContains?: string };
  steps: Array<{ type: string; language?: string }>;
  runCount: number;
  lastRunAt: string | null;
};

/** Semantic search, and the rules that run automatically on upload. */
function AiToolsCard({ overview, refresh }: { overview: AiOverview; refresh: () => Promise<AiOverview | null> }) {
  const rules = overview.automations;
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ fileId: string; fileName: string; score: number; excerpt: string }> | null>(null);
  const [searching, setSearching] = useState(false);

  const [name, setName] = useState("");
  const [mimePrefix, setMimePrefix] = useState("image/");
  const [stepType, setStepType] = useState("ocr");


  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const d = await apiFetch<{ hits: typeof hits }>("/api/ai/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: query.trim() })
      });
      setHits(d.hits ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  };

  const createRule = async () => {
    if (!name.trim()) {
      toast.error("Give the rule a name.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/api/ai/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          trigger: { event: "file.uploaded", ...(mimePrefix.trim() ? { mimePrefix: mimePrefix.trim() } : {}) },
          steps: [{ type: stepType }]
        })
      });
      setName("");
      toast.success("Rule created.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the rule.");
    } finally {
      setBusy(false);
    }
  };

  const patchRule = async (row: AutomationRow, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await apiFetch(`/api/ai/automations/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the rule.");
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (row: AutomationRow) => {
    setBusy(true);
    try {
      await apiFetch(`/api/ai/automations/${row.id}`, { method: "DELETE" });
      toast.success("Rule removed.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the rule.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-5 lg:col-span-2">
      <h2 className="display t-h2">AI tools</h2>

      <p className="eyebrow mt-4">Semantic search</p>
      <p className="t-xs mt-1" style={{ color: "var(--text-3)" }}>
        Searches the meaning of indexed documents, not just their names. A file has to be indexed first — add an
        “Index” rule below, or index one from its menu.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") search();
          }}
          placeholder="e.g. the invoice from the landlord"
          className="field"
          style={{ minHeight: 44, flex: "1 1 260px" }}
          aria-label="Semantic search query"
        />
        <button onClick={search} disabled={searching} className="btn btn-accent" style={{ minHeight: 44 }}>
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Search
        </button>
      </div>

      {hits !== null && (
        <ul className="mt-3 grid gap-1.5">
          {hits.length === 0 ? (
            <li className="t-sm" style={{ color: "var(--text-3)" }}>
              No matches. Nothing is indexed yet, or nothing came close.
            </li>
          ) : (
            hits.map(h => (
              <li key={h.fileId} className="rounded-lg px-3 py-2" style={{ background: "var(--surface)" }}>
                <p className="t-sm font-semibold" style={{ color: "var(--text-1)" }}>
                  {h.fileName} <span className="t-xs mono font-normal" style={{ color: "var(--text-3)" }}>{h.score.toFixed(3)}</span>
                </p>
                <p className="t-xs mt-0.5" style={{ color: "var(--text-3)" }}>{h.excerpt}</p>
              </li>
            ))
          )}
        </ul>
      )}

      <p className="eyebrow mt-6">Automations</p>
      <p className="t-xs mt-1" style={{ color: "var(--text-3)" }}>
        Run automatically when a matching file finishes uploading. These need the background worker
        (<span className="mono">JOB_WORKER_ENABLED=1</span>) to actually execute.
      </p>

      {rules.length > 0 && (
        <ul className="mt-2 grid gap-1.5">
          {rules.map(r => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2" style={{ background: "var(--surface)" }}>
              <div className="min-w-0 flex-1">
                <p className="t-sm font-semibold" style={{ color: "var(--text-1)" }}>{r.name}</p>
                <p className="t-xs mono mt-0.5" style={{ color: "var(--text-3)" }}>
                  on upload{r.trigger.mimePrefix ? ` · ${r.trigger.mimePrefix}*` : ""} → {r.steps.map(s => s.type).join(", ")} · ran {r.runCount}×
                </p>
              </div>
              <Tag tone={r.enabled ? "ok" : undefined}>{r.enabled ? "on" : "off"}</Tag>
              <button onClick={() => patchRule(r, { enabled: !r.enabled })} disabled={busy} className="btn btn-ghost" style={{ minHeight: 36 }}>
                <Power className="h-4 w-4" />
              </button>
              <button onClick={() => removeRule(r)} disabled={busy} className="btn btn-ghost" style={{ minHeight: 36 }}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Rule name" className="field" style={{ minHeight: 44, flex: "1 1 180px" }} aria-label="Rule name" />
        <input value={mimePrefix} onChange={e => setMimePrefix(e.target.value)} placeholder="image/" className="field mono" style={{ minHeight: 44, width: 130 }} aria-label="MIME prefix" />
        <select value={stepType} onChange={e => setStepType(e.target.value)} className="field" style={{ minHeight: 44, width: 150 }} aria-label="Step">
          {["ocr", "caption", "summarize", "transcribe", "index", "favorite"].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button onClick={createRule} disabled={busy} className="btn btn-accent" style={{ minHeight: 44 }}>
          Add rule
        </button>
      </div>
    </section>
  );
}

/** Tasks the user can route differently from their account-wide default. */
const AI_TASKS: Array<[string, string]> = [
  ["summarize", "Summarize"],
  ["translate", "Translate"],
  ["chat", "Document chat"],
  ["ocr", "Image OCR"],
  ["caption", "Image caption"],
  ["transcribe", "Transcribe"]
];

const MODE_BLURB: Record<string, string> = {
  free: "Only keys that cost nothing — local, or priced at 0. An unpriced key is excluded, because unknown is not free.",
  premium: "Every enabled key, best-first by the priority you set.",
  hybrid: "Every enabled key, cheapest first, falling back up the chain.",
  offline: "Only your own machine. Nothing leaves it.",
  custom: "Your own strategy, plus per-task overrides below."
};

/** Account-wide AI mode, with per-task overrides. */
function AiModeCard({ overview }: { overview: AiOverview }) {
  const modes = overview.modes;
  const [mode, setMode] = useState(overview.preferences.mode);
  const [strategy, setStrategy] = useState(overview.preferences.strategy);
  const [overrides, setOverrides] = useState<Record<string, { mode?: string }>>(overview.preferences.taskOverrides || {});
  const [saving, setSaving] = useState(false);

  const save = async (next: { mode?: string; strategy?: string; taskOverrides?: Record<string, { mode?: string }> }) => {
    const body = { mode, strategy, taskOverrides: overrides, ...next };
    setSaving(true);
    try {
      await apiFetch("/api/ai/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      setMode(body.mode);
      setStrategy(body.strategy);
      setOverrides(body.taskOverrides);
      toast.success("AI mode saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save AI settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel p-5 lg:col-span-2">
      <h2 className="display t-h2">AI mode</h2>
      <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-3)" }}>
        {MODE_BLURB[mode] || ""}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {modes.map(m => (
          <button
            key={m}
            onClick={() => save({ mode: m })}
            disabled={saving}
            className={mode === m ? "btn btn-accent" : "btn btn-ghost"}
            style={{ minHeight: 40, textTransform: "capitalize" }}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "custom" && (
        <label className="mt-4 grid gap-1 sm:max-w-xs">
          <span className="eyebrow">Key rotation</span>
          <select value={strategy} onChange={e => save({ strategy: e.target.value })} disabled={saving} className="field" style={{ minHeight: 44 }}>
            {["priority", "round-robin", "least-used", "lowest-cost", "fastest"].map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-5">
        <p className="eyebrow">Per-task override</p>
        <p className="t-xs mt-1" style={{ color: "var(--text-3)" }}>
          Leave as “Default” to use the mode above. Useful for keeping something sensitive offline while everything
          else uses a hosted model.
        </p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {AI_TASKS.map(([task, label]) => (
            <li key={task} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: "var(--surface)" }}>
              <span className="t-sm" style={{ color: "var(--text-1)" }}>{label}</span>
              <select
                value={overrides[task]?.mode || ""}
                disabled={saving}
                onChange={e => {
                  const next = { ...overrides };
                  if (e.target.value) next[task] = { mode: e.target.value };
                  else delete next[task];
                  save({ taskOverrides: next });
                }}
                className="field"
                style={{ width: 130, minHeight: 36, padding: "0.3rem 0.5rem" }}
                aria-label={`Mode for ${label}`}
              >
                <option value="">Default</option>
                {modes.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Micro-USD to a readable amount. Sub-cent spend is common, so it does not
 *  round to two places and claim $0.00 for real usage. */
function formatUsd(micros: number) {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * AI usage and spend.
 *
 * Cost is only meaningful for models the operator has priced (AI_PRICING_JSON),
 * so the card reports how many calls were priced rather than presenting a total
 * that silently ignores the rest.
 */
function AiUsageCard({ overview }: { overview: AiOverview }) {
  // The 30-day window came with the overview; any other range is its own call.
  const [data, setData] = useState<AiUsage>(overview.usage);
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (days === 30) {
      setData(overview.usage);
      return;
    }
    let cancelled = false;
    apiFetch<AiUsage>(`/api/ai/usage?days=${days}`)
      .then(d => {
        if (!cancelled) setData(d);
      })
      .catch(err => {
        if (cancelled) return;
        if (!(err instanceof ApiError && err.status === 404)) toast.error("Could not load AI usage.");
      });
    return () => {
      cancelled = true;
    };
  }, [days, overview.usage]);

  const peak = Math.max(1, ...data.byDay.map(d => d.calls));
  const unpriced = data.calls - data.pricedCalls;

  return (
    <section className="panel p-5 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="display t-h2">AI usage</h2>
        <div className="flex gap-1.5">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} className={days === d ? "btn btn-accent" : "btn btn-ghost"} style={{ minHeight: 34, fontSize: 12 }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {data.calls === 0 ? (
        <p className="t-sm mt-4" style={{ color: "var(--text-3)" }}>
          No AI calls in the last {data.days} days.
        </p>
      ) : (
        <>
          <ul className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              ["Calls", String(data.calls)],
              ["Tokens", formatTokens(data.promptTokens + data.completionTokens)],
              ["Cost", formatUsd(data.costMicros)],
              ["Avg latency", `${data.avgLatencyMs} ms`]
            ].map(([label, value]) => (
              <li key={label} className="rounded-xl p-3.5" style={{ background: "var(--surface)" }}>
                <p className="eyebrow">{label}</p>
                <p className="t-body mt-1 font-semibold" style={{ color: "var(--text-1)" }}>{value}</p>
              </li>
            ))}
          </ul>

          {(unpriced > 0 || data.errors > 0) && (
            <p className="t-xs mt-3" style={{ color: "var(--text-3)" }}>
              {unpriced > 0 && (
                <>
                  {unpriced} of {data.calls} calls have no configured price, so they are not counted in the cost.
                  Set <span className="mono">AI_PRICING_JSON</span> to include them.
                </>
              )}
              {unpriced > 0 && data.errors > 0 ? " " : ""}
              {data.errors > 0 && <>{data.errors} call{data.errors === 1 ? "" : "s"} failed.</>}
            </p>
          )}

          {/* Per-day calls. A plain CSS bar chart — no charting dependency for
              what is a single series. */}
          {data.byDay.length > 0 && (
            <div className="mt-5">
              <p className="eyebrow">Calls per day</p>
              <div className="mt-2 flex items-end gap-1" style={{ height: 72 }}>
                {data.byDay.map(d => (
                  <div
                    key={d.day}
                    title={`${d.day} · ${d.calls} call${d.calls === 1 ? "" : "s"} · ${formatUsd(d.costMicros)}`}
                    className="flex-1 rounded-t"
                    style={{
                      height: `${Math.max(4, (d.calls / peak) * 100)}%`,
                      background: "var(--accent)",
                      opacity: 0.55,
                      minWidth: 3
                    }}
                  />
                ))}
              </div>
              <div className="t-xs mt-1 flex justify-between" style={{ color: "var(--text-3)" }}>
                <span>{data.byDay[0]?.day}</span>
                <span>{data.byDay[data.byDay.length - 1]?.day}</span>
              </div>
            </div>
          )}

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="eyebrow">By provider</p>
              <ul className="mt-2 grid gap-1.5">
                {data.byProvider.map(p => (
                  <li key={p.provider} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: "var(--surface)" }}>
                    <span className="t-sm" style={{ color: "var(--text-1)" }}>{p.provider}</span>
                    <span className="t-xs mono" style={{ color: "var(--text-3)" }}>
                      {p.calls} · {formatTokens(p.promptTokens + p.completionTokens)} · {formatUsd(p.costMicros)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="eyebrow">By task</p>
              <ul className="mt-2 grid gap-1.5">
                {data.byTask.map(t => (
                  <li key={t.task} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: "var(--surface)" }}>
                    <span className="t-sm" style={{ color: "var(--text-1)" }}>{t.task}</span>
                    <span className="t-xs mono" style={{ color: "var(--text-3)" }}>
                      {t.calls} · {formatUsd(t.costMicros)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Bring-your-own AI keys.
 *
 * The card asks the server whether the feature exists rather than reading a
 * build-time flag: `/api/ai/keys` answers 404 when AI_ENABLED is unset, and the
 * whole section renders nothing. That keeps one source of truth on the server
 * and means switching the flag needs a restart, not a rebuild — which matters
 * because NEXT_PUBLIC_* values are baked into the bundle at build time.
 */
/**
 * The AI cards, once — or not at all.
 *
 * Every card used to decide for itself whether the feature existed, which meant
 * four independent "loading, then maybe nothing" states popping in one after
 * another. One request answers for all of them: while it is in flight the
 * section is a skeleton, a 404 (the feature switched off on this server) removes
 * it entirely, and the cards mount already holding their data.
 *
 * A genuine failure is the fourth state, and it is not a toast. "Could not load
 * AI settings" beside an empty page said nothing about whether AI was off or
 * broken, and offered no way to try again; it now says what went wrong where the
 * section would have been, with a button.
 */
function AiSection() {
  const [overview, setOverview] = useState<AiOverview | null>(null);
  const [state, setState] = useState<"loading" | "on" | "off" | "failed">("loading");
  const [failure, setFailure] = useState("");

  const refresh = useCallback(
    () =>
      reloadAiOverview()
        .then(d => {
          setOverview(d);
          return d;
        })
        .catch(() => null),
    []
  );

  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const load = useCallback((fresh = false) => {
    setState("loading");
    return (fresh ? reloadAiOverview() : loadAiOverview())
      .then(d => {
        if (cancelled.current) return;
        setOverview(d);
        setState("on");
      })
      .catch(err => {
        if (cancelled.current) return;
        // 404 is the flag being off on this server: the section does not exist,
        // rather than having failed. Anything else is a real failure and gets
        // said in place — a toast plus a vanishing section left no way to tell
        // "AI is off here" from "AI is broken here", and no way to try again.
        if (err instanceof ApiError && err.status === 404) {
          setState("off");
          return;
        }
        setFailure(err instanceof Error ? err.message : "Could not load AI settings.");
        setState("failed");
      });
  }, []);

  // The skeleton stays up for the whole attempt, retries included, so the
  // section never flashes an error on its way to succeeding.
  useEffect(() => {
    void load();
  }, [load]);

  if (state === "off") return null;

  if (state === "failed") {
    return (
      <section className="panel p-5 lg:col-span-2">
        <h2 className="display t-h2">AI</h2>
        <p className="t-sm mt-3" style={{ color: "var(--text-3)" }}>{failure}</p>
        <button onClick={() => void load(true)} className="btn btn-ghost mt-4" style={{ minHeight: 40 }}>
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
      </section>
    );
  }

  if (state === "loading" || !overview) {
    return (
      <section className="panel p-5 lg:col-span-2" aria-busy="true" aria-label="Loading AI settings">
        <div className="skeleton h-6 w-32 rounded-lg" />
        <div className="mt-4">
          <PanelSkeleton rows={2} />
        </div>
      </section>
    );
  }

  return (
    <>
      <AiKeysCard overview={overview} refresh={refresh} />
      <AiModeCard overview={overview} />
      <AiToolsCard overview={overview} refresh={refresh} />
      <AiUsageCard overview={overview} />
    </>
  );
}

type DraftKey = { rowId: string; provider: string; apiKey: string; model: string; baseUrl: string; nickname: string };

let draftSeq = 0;
function blankDraft(provider: string): DraftKey {
  return { rowId: `draft-${++draftSeq}`, provider, apiKey: "", model: "", baseUrl: "", nickname: "" };
}

function AiKeysCard({ overview, refresh }: { overview: AiOverview; refresh: () => Promise<AiOverview | null> }) {
  const providers = overview.providers;
  const keys = overview.keys;
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Several at once: the whole point of the vault is a fallback chain, and
  // adding four keys used to mean four rounds of the same form.
  const [drafts, setDrafts] = useState<DraftKey[]>(() => [blankDraft(providers[0]?.id || "")]);

  const specFor = (id: string) => providers.find(p => p.id === id) || null;
  const editDraft = (rowId: string, patchDraft: Partial<DraftKey>) =>
    setDrafts(rows => rows.map(row => (row.rowId === rowId ? { ...row, ...patchDraft } : row)));

  /**
   * Save every filled row.
   *
   * Sequential rather than parallel: each row is a separate insert whose
   * generated name depends on what is already stored, and a row that fails
   * should not take the others down with it — so failures are collected and
   * reported per row while the rest go through.
   */
  const submit = async () => {
    const filled = drafts.filter(row => row.apiKey.trim());
    if (!filled.length) {
      toast.error("Paste at least one API key.");
      return;
    }
    setAdding(true);
    const failed: DraftKey[] = [];
    let saved = 0;
    for (const row of filled) {
      try {
        await apiFetch("/api/ai/keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: row.provider,
            nickname: row.nickname.trim(),
            apiKey: row.apiKey.trim(),
            // Omitted, not empty: the server fills in the provider's default.
            model: row.model.trim() || undefined,
            baseUrl: row.baseUrl.trim() || null
          })
        });
        saved++;
      } catch (err) {
        failed.push(row);
        toast.error(`${specFor(row.provider)?.label || row.provider}: ${err instanceof Error ? err.message : "could not be saved."}`);
      }
    }
    // Secrets leave component state the moment they are stored; only rows that
    // still need attention are kept.
    setDrafts(failed.length ? failed : [blankDraft(providers[0]?.id || "")]);
    if (saved) toast.success(saved > 1 ? `${saved} keys saved.` : "Key saved.");
    await refresh();
    setAdding(false);
  };

  const patch = async (row: AiKeyRow, body: Record<string, unknown>) => {
    setBusy(row.id);
    try {
      await apiFetch(`/api/ai/keys/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the key.");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (row: AiKeyRow) => patch(row, { enabled: !row.enabled });

  const remove = async (row: AiKeyRow) => {
    setBusy(row.id);
    try {
      await apiFetch(`/api/ai/keys/${row.id}`, { method: "DELETE" });
      toast.success("Key removed.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the key.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel p-5 lg:col-span-2">
      <h2 className="display t-h2">AI keys</h2>
      <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-3)" }}>
        Bring your own provider key. Keys are encrypted before they are stored and never sent back to this page —
        only the last four characters are shown. Choose <span className="font-semibold">Local</span> and point it at
        your own machine (Ollama, LM Studio, llama.cpp, vLLM) to keep everything on your hardware.
      </p>

      {keys.length > 0 && (
        <ul className="mt-4 grid gap-2">
          {keys.map(row => {
            const label = providers.find(p => p.id === row.provider)?.label || row.provider;
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-xl p-3.5" style={{ background: "var(--surface)" }}>
                <div className="min-w-0 flex-1">
                  <p className="t-body font-semibold" style={{ color: "var(--text-1)" }}>
                    {row.nickname}{" "}
                    <span className="t-xs font-normal" style={{ color: "var(--text-3)" }}>· {label}</span>
                  </p>
                  <p className="t-xs mono mt-0.5" style={{ color: "var(--text-3)" }}>
                    ••••{row.hint} · {row.model || "no model"}
                    {row.baseUrl ? ` · ${row.baseUrl}` : ""}
                  </p>
                  {row.lastError && !row.enabled && (
                    <p className="t-xs mt-1" style={{ color: "var(--danger)" }}>{row.lastError}</p>
                  )}
                </div>

                {/* Priority orders the router's fallback chain; the limit caps
                    spend per UTC day. Both are stored in micro-USD server-side,
                    but a person thinks in dollars, so the field converts. */}
                <label className="t-xs flex items-center gap-1.5" style={{ color: "var(--text-3)" }}>
                  Priority
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    defaultValue={row.priority}
                    onBlur={e => {
                      const next = Number(e.target.value);
                      if (Number.isFinite(next) && next !== row.priority) patch(row, { priority: next });
                    }}
                    className="field mono"
                    style={{ width: 68, minHeight: 36, padding: "0.3rem 0.5rem" }}
                    aria-label={`Priority for ${row.nickname}`}
                  />
                </label>

                <label className="t-xs flex items-center gap-1.5" style={{ color: "var(--text-3)" }}>
                  $/day
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="none"
                    defaultValue={row.dailyLimitMicros === null ? "" : row.dailyLimitMicros / 1_000_000}
                    onBlur={e => {
                      const raw = e.target.value.trim();
                      const next = raw === "" ? null : Math.round(Number(raw) * 1_000_000);
                      if (next !== null && !Number.isFinite(next)) return;
                      if (next !== row.dailyLimitMicros) patch(row, { dailyLimitMicros: next });
                    }}
                    className="field mono"
                    style={{ width: 84, minHeight: 36, padding: "0.3rem 0.5rem" }}
                    aria-label={`Daily spend limit for ${row.nickname}`}
                  />
                </label>

                <Tag tone={!row.enabled ? "danger" : row.health === "ok" ? "ok" : row.health === "failing" ? "danger" : undefined}>
                  {row.enabled ? row.health : "off"}
                </Tag>

                <button onClick={() => toggle(row)} disabled={busy === row.id} className="btn btn-ghost" style={{ minHeight: 40 }}>
                  <Power className="h-4 w-4" />
                  {row.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => remove(row)} disabled={busy === row.id} className="btn btn-ghost" style={{ minHeight: 40 }}>
                  {busy === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 grid gap-3">
        {drafts.map((row, index) => {
          const spec = specFor(row.provider);
          return (
            <div key={row.rowId} className="grid gap-2 rounded-xl p-3 sm:grid-cols-2" style={{ background: "var(--surface)" }}>
              <label className="grid gap-1">
                <span className="eyebrow">Provider</span>
                {/* A dropdown, never a text field: a mistyped provider is a key
                    that can never be routed anywhere. */}
                <select
                  value={row.provider}
                  onChange={e => editDraft(row.rowId, { provider: e.target.value })}
                  className="field"
                  style={{ minHeight: 44 }}
                >
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1">
                <span className="eyebrow">API key</span>
                <input
                  type="password"
                  value={row.apiKey}
                  onChange={e => editDraft(row.rowId, { apiKey: e.target.value })}
                  placeholder={spec?.local ? "any value your runtime accepts" : "sk-…"}
                  autoComplete="off"
                  className="field"
                  style={{ minHeight: 44 }}
                />
              </label>

              <label className="grid gap-1">
                <span className="eyebrow">Model (optional)</span>
                <input
                  value={row.model}
                  onChange={e => editDraft(row.rowId, { model: e.target.value })}
                  placeholder={spec?.defaultModel || "provider default"}
                  className="field"
                  style={{ minHeight: 44 }}
                />
              </label>

              <label className="grid gap-1">
                <span className="eyebrow">
                  Base URL {spec?.requiresBaseUrl ? "(required)" : "(optional)"}
                </span>
                <input
                  value={row.baseUrl}
                  onChange={e => editDraft(row.rowId, { baseUrl: e.target.value })}
                  placeholder={spec?.defaultBaseUrl || "http://localhost:11434/v1"}
                  className="field"
                  style={{ minHeight: 44 }}
                />
              </label>

              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                {spec?.keysUrl && (
                  <a href={spec.keysUrl} target="_blank" rel="noreferrer" className="t-xs underline" style={{ color: "var(--text-3)" }}>
                    Get a {spec.label} key
                  </a>
                )}
                {drafts.length > 1 && (
                  <button
                    onClick={() => setDrafts(rows => rows.filter(r => r.rowId !== row.rowId))}
                    className="t-xs ml-auto"
                    style={{ color: "var(--danger)" }}
                    aria-label={`Remove key row ${index + 1}`}
                  >
                    Remove row
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={submit} disabled={adding} className="btn btn-accent" style={{ minHeight: 44 }}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {drafts.filter(r => r.apiKey.trim()).length > 1 ? "Save keys" : "Save key"}
        </button>
        <button
          onClick={() => setDrafts(rows => [...rows, blankDraft(rows[rows.length - 1]?.provider || providers[0]?.id || "")])}
          className="btn btn-ghost"
          style={{ minHeight: 44 }}
        >
          <Plus className="h-4 w-4" />
          Add another key
        </button>
        <span className="t-xs" style={{ color: "var(--text-3)" }}>
          Several keys make a fallback chain — if one is rate limited or out of credit, the next takes over.
        </span>
      </div>
    </section>
  );
}

/**
 * QR polling cadence.
 *
 * Telegram's login token lives ~30 s and every poll mints a fresh one, so this
 * doubles as the redraw interval. Four seconds is frequent enough that the code
 * on screen is always live, without minting tokens fast enough to trip a flood
 * wait. Give-up is generous because a cold free-tier instance can take tens of
 * seconds to answer the first request.
 */
const QR_POLL_MS = 4_000;
const QR_GIVE_UP_MS = 3 * 60_000;
const QR_MAX_FAILURES = 5;

/** Link the user's own Telegram account over MTProto (QR or phone code). */
function TelegramLinkCard({ link, onChanged }: { link: TelegramLink | null; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "qr" | "phone">("idle");
  const [qrUrl, setQrUrl] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"start" | "code" | "password">("start");
  const [busy, setBusy] = useState(false);
  const [qrError, setQrError] = useState("");
  /** What the handshake is actually doing, so the panel never just spins. */
  const [qrState, setQrState] = useState<"waiting" | "migrating">("waiting");
  /** Which channel Telegram actually used for the login code. */
  const [delivery, setDelivery] = useState<string>("");

  const post = useCallback(async (body: Record<string, unknown>) => {
    return apiFetch<{ status?: string; state?: string; delivery?: string; qrUrl?: string; expiresAt?: number; premium?: boolean; name?: string }>("/api/telegram/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }, []);

  /**
   * Poll while a QR is on screen.
   *
   * Every poll asks Telegram for the current login token, and Telegram issues a
   * *new* one each time — so the answer always carries the QR that is actually
   * live, and it is redrawn here. Without that the code on screen goes stale
   * within one interval: the phone reports a successful scan while this panel
   * waits forever for an acceptance that can never arrive.
   *
   * A self-scheduling timeout rather than setInterval, so a slow response on a
   * cold Render instance cannot stack overlapping requests.
   */
  useEffect(() => {
    if (mode !== "qr") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;

      if (Date.now() - startedAt > QR_GIVE_UP_MS) {
        setQrError("This QR code expired. Start again, or use your phone number.");
        return;
      }

      try {
        const result = await post({ action: "qr-poll" });
        if (cancelled) return;
        failures = 0;
        setQrError("");
        if (result.state === "migrating" || result.state === "waiting") setQrState(result.state);
        if (typeof window !== "undefined" && window.localStorage.getItem("td:debugLink") === "1") {
          // Opt-in client trace, paired with DEBUG_TG_LINK=1 on the server.
          console.log("[tg-link] poll ->", result.status, result.state ?? "", "qr=", Boolean(result.qrUrl));
        }

        if (result.status === "linked") {
          toast.success(`Telegram account linked${result.premium ? " (Premium — 4 GB files)" : ""}`);
          setMode("idle");
          setQrUrl("");
          onChanged();
          return;
        }
        if (result.status === "password") {
          // A 2FA account gets this far and then needs the cloud password.
          setStep("password");
          setMode("phone");
          setQrUrl("");
          toast.info("Two-step verification is on — enter your cloud password.");
          return;
        }
        // Still waiting. Redraw whatever token is current now.
        if (result.qrUrl) setQrUrl(result.qrUrl);
      } catch (err) {
        if (cancelled) return;
        // A 409 means the server has no half-finished login left (restart, or
        // it was cleared) — polling can never succeed, so say so and stop.
        if (err instanceof ApiError && err.status === 409) {
          setQrError("This login attempt expired. Start again.");
          return;
        }
        // Anything else — a cold instance, a dropped connection — is worth
        // retrying, backing off so a sleeping host is not hammered.
        failures += 1;
        if (failures >= QR_MAX_FAILURES) {
          // The actual message, not a generic one — it is usually a Telegram
          // error worth reading (a flood wait, a dead session).
          setQrError(err instanceof Error ? err.message : "Lost contact with the server. Start again.");
          return;
        }
      }

      timer = setTimeout(tick, failures ? Math.min(QR_POLL_MS * 2 ** failures, 15_000) : QR_POLL_MS);
    };

    timer = setTimeout(tick, QR_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, post, onChanged]);

  if (!link) return <section className="panel p-5"><PanelSkeleton rows={1} /></section>;

  const missing = link.missingEnv ?? [];

  // Naming the variables matters: the same build behaves differently per host
  // purely on environment, and "unavailable" with no reason is indistinguishable
  // from a bug when it works on localhost.
  if (!link.available || missing.length) {
    return (
      <section className="panel p-5">
        <h2 className="display t-h2">Your Telegram account</h2>
        <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-2)" }}>
          Account linking is unavailable on this host because{" "}
          {missing.length ? (
            <>
              {missing.length === 1 ? "this variable is" : "these variables are"} not set:{" "}
              {missing.map((k, i) => (
                <span key={k}>
                  {i > 0 ? ", " : ""}
                  <span className="mono">{k}</span>
                </span>
              ))}
              .
            </>
          ) : (
            <>
              <span className="mono">API_ID</span> / <span className="mono">API_HASH</span> are not set.
            </>
          )}{" "}
          Bot storage still handles files up to {formatBytes(MAX_FILE_SIZE)}.
        </p>
        {missing.includes("SESSION_ENCRYPTION_KEY") ? (
          <p className="t-xs mt-2 leading-relaxed" style={{ color: "var(--text-3)" }}>
            <span className="mono">SESSION_ENCRYPTION_KEY</span> encrypts the stored Telegram session. Linking is
            blocked without it rather than saving your session in clear text.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="display t-h2">Your Telegram account</h2>
        {link.linked ? (
          <span className="chip" style={{ color: "var(--emerald)", background: "rgba(52,211,153,0.1)", borderColor: "rgba(52,211,153,0.3)" }}>
            <Check className="h-3 w-3" /> Linked
          </span>
        ) : null}
      </div>

      <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-2)" }}>
        {link.linked
          ? `Big files are stored as a single message in your Saved Messages — up to ${formatBytes(link.maxBytes)} each.`
          : `Link your account to store large files as one message instead of hundreds of 4 MB chunks. Raises the per-file ceiling to ${formatBytes(MAX_FILE_SIZE)} (4 GB with Premium).`}
      </p>

      {link.linked ? (
        <button
          className="btn btn-ghost mt-4"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await post({ action: "unlink" });
              toast.success("Account unlinked");
              onChanged();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Could not unlink.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Unlink className="h-4 w-4" /> Unlink account
        </button>
      ) : mode === "idle" ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await post({ action: "qr-start" });
                setQrUrl(result.qrUrl || "");
                setQrError("");
                setMode("qr");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not start QR login.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Link with QR
          </button>
          <button className="btn btn-ghost" onClick={() => { setMode("phone"); setStep("start"); }}>
            <Smartphone className="h-4 w-4" /> Use phone number
          </button>
        </div>
      ) : mode === "qr" ? (
        <div className="mt-4">
          <p className="t-sm" style={{ color: "var(--text-2)" }}>
            In Telegram: <b>Settings → Devices → Link Desktop Device</b>, then scan this.
          </p>
          <div className="mt-3 inline-block rounded-xl bg-white p-3">
            {/* Rendered from the tg:// login URL Telegram returned. */}
            <QrCanvas value={qrUrl} />
          </div>
          {qrError ? (
            <p className="t-sm mt-3 rounded-xl px-3.5 py-3 leading-relaxed"
               style={{ background: "var(--danger-dim)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}>
              {qrError}
            </p>
          ) : (
            <p className="t-xs mt-2 flex items-center gap-2" style={{ color: "var(--text-3)" }}>
              <Loader2 className="h-3 w-3 animate-spin" />
              {qrState === "migrating"
                ? "Scanned — moving your session to your account's data centre…"
                : "Waiting for the scan — the code refreshes itself."}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-ghost" onClick={() => { setMode("idle"); setQrUrl(""); setQrError(""); }}>
              {qrError ? "Back" : "Cancel"}
            </button>
            {qrError ? (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await post({ action: "qr-start" });
                    setQrUrl(result.qrUrl || "");
                    setQrError("");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Could not start QR login.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Try again
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {step === "start" ? (
            <>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" className="field" inputMode="tel" aria-label="Phone number" />
              <div className="flex gap-2">
                <button className="btn btn-ghost" onClick={() => setMode("idle")}>Back</button>
                <button
                  className="btn btn-primary"
                  disabled={busy || phone.trim().length < 6}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const sent = await post({ action: "phone-start", phone: phone.replace(/\s/g, "") });
                      setDelivery(sent.delivery || "");
                      setStep("code");
                      toast.success(
                        sent.delivery === "sms"
                          ? "Code sent by SMS."
                          : sent.delivery === "call"
                            ? "Telegram is calling you with the code."
                            : "Code sent to your Telegram app."
                      );
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Could not send a code.");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Send code
                </button>
              </div>
            </>
          ) : step === "code" ? (
            <>
              <p className="t-sm leading-relaxed" style={{ color: "var(--text-2)" }}>
                {delivery === "sms" ? (
                  <>Telegram sent the code by <b>SMS</b> to that number.</>
                ) : delivery === "call" ? (
                  <>Telegram is <b>calling</b> that number and will read the code aloud.</>
                ) : (
                  <>
                    Telegram sent the code to your <b>Telegram app</b>, not by SMS — open any device where you are
                    already signed in and look for the message from <b>Telegram</b>. SMS is only used when the account
                    has no active session.
                  </>
                )}
              </p>
              <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="Login code" className="field mono" inputMode="numeric" aria-label="Login code" />
              <button
                className="btn btn-primary"
                disabled={busy || code.length < 3}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await post({ action: "phone-code", code });
                    if (result.status === "password") {
                      setStep("password");
                      toast.info("Two-step verification is on — enter your cloud password.");
                    } else {
                      toast.success("Telegram account linked");
                      setMode("idle");
                      onChanged();
                    }
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "That code didn't work.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
              </button>
            </>
          ) : (
            <>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Cloud password" className="field" aria-label="Telegram cloud password" />
              <button
                className="btn btn-primary"
                disabled={busy || !password}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await post({ action: "password", password });
                    toast.success("Telegram account linked");
                    setMode("idle");
                    onChanged();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Password rejected.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Renders the tg:// login URL Telegram returned. The encoder is imported lazily
 *  so it only ships to users who actually open the linking flow. */
function QrCanvas({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    import("qrcode")
      .then(mod => mod.toDataURL(value, { margin: 0, width: 208, errorCorrectionLevel: "L" }))
      .then(url => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <a href={value} className="t-xs break-all" style={{ color: "#000" }}>
        {value}
      </a>
    );
  }
  if (!dataUrl) {
    return (
      <div style={{ width: 208, height: 208, display: "grid", placeItems: "center" }}>
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: "#000" }} />
      </div>
    );
  }
  return <img src={dataUrl} width={208} height={208} alt="Telegram login QR code" />;
}

// ── About ───────────────────────────────────────────────────────────────────

/**
 * Baked in by next.config.mjs at build time. The fallback is for a bundle built
 * before this existed — better a quiet "dev" than a crash on a stale deploy.
 */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || "";

export function AboutPanel({ maxBytes }: { maxBytes: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel p-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="display t-h2">TeleDrive</h2>
          {/* The answer to "did my deploy actually go out?" — read it here after
              every push rather than guessing from a page that looks the same. */}
          <Tag tone="ok">v{APP_VERSION}</Tag>
        </div>
        {BUILD_TIME ? (
          <p className="mono mt-1.5" style={{ color: "var(--text-3)" }}>Built {BUILD_TIME}</p>
        ) : null}
        <p className="t-sm mt-3 leading-relaxed" style={{ color: "var(--text-2)" }}>
          A self-hostable personal cloud that uses Telegram as its storage layer. Files are chunked and sent to your own
          chat with the bot, so the data stays in an account you control — and the bot token never leaves the server.
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-2.5">
          {[
            ["Storage", "Your Telegram"],
            ["Max file", formatBytes(maxBytes)],
            ["Chunk size", "4 MB"],
            ["Auth", "Telegram · Google"]
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl p-3" style={{ background: "var(--surface)" }}>
              <dt className="eyebrow">{label}</dt>
              <dd className="t-sm m-0 mt-1 font-semibold" style={{ color: "var(--text-1)" }}>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel p-6">
        <h2 className="display t-h2">Contact</h2>
        <p className="t-sm mt-3" style={{ color: "var(--text-2)" }}>
          Built by Mohit Gautam. Feedback, bugs and collaborations welcome.
        </p>
        <a href="mailto:mohitgautam905835@gmail.com" className="btn btn-primary mt-5 w-full" style={{ minHeight: 46 }}>
          <Mail className="h-4 w-4" />
          mohitgautam905835@gmail.com
        </a>
        <p className="t-xs mt-4 leading-relaxed" style={{ color: "var(--text-3)" }}>
          Next.js · Prisma · Postgres · Telegram Bot API &amp; MTProto
        </p>
      </section>
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function Tag({ children, tone }: { children: React.ReactNode; tone?: "ok" | "danger" }) {
  const style =
    tone === "ok"
      ? { color: "var(--emerald)", background: "rgba(52,211,153,0.1)", borderColor: "rgba(52,211,153,0.28)" }
      : tone === "danger"
        ? { color: "var(--danger)", background: "var(--danger-dim)", borderColor: "var(--danger-border)" }
        : { color: "var(--text-2)", background: "var(--surface)", borderColor: "var(--border-dim)" };
  return <span className="chip" style={style}>{children}</span>;
}

export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="panel flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-5 grid h-14 w-14 place-items-center rounded-2xl" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)" }}>
        {icon}
      </span>
      <p className="display t-h2">{title}</p>
      <p className="t-sm mt-2 max-w-[42ch] leading-relaxed" style={{ color: "var(--text-3)" }}>{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function AuthBadge({ status }: { status: "connected" | "pending" | "failed" }) {
  if (status === "pending") return <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--accent)" }} />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5" style={{ color: "var(--danger)" }} />;
  return <Check className="h-3.5 w-3.5" style={{ color: "var(--emerald)" }} />;
}
