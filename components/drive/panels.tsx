"use client";

import { useCallback, useEffect, useState } from "react";
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
  Power,
  Smartphone,
  Sun,
  Trash2,
  Unlink
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatBytes } from "@/lib/utils";
import { MAX_FILE_SIZE } from "@/lib/upload-config";
import type { AiKeyRow, AiProvider, AiUsage, Insights, ShareRow, TelegramLink, ThemeMode } from "./types";

// ── Shared view ─────────────────────────────────────────────────────────────

export function SharesPanel() {
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
        <motion.div
          key={share.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: Math.min(i * 0.03, 0.2), ease: [0.22, 1, 0.36, 1] }}
          className="card p-4"
        >
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

export function InsightsPanel({ insights, onOpenFile }: { insights: Insights | null; onOpenFile: (id: string) => void }) {
  // The sidebar's cheap stats call only fills totalSize/count; wait for the
  // full breakdown before drawing the charts.
  if (!insights?.byType || !insights.byBackend || !insights.largest) return <PanelSkeleton rows={2} />;

  const total = insights.byType.reduce((sum, t) => sum + t.bytes, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel p-5 lg:col-span-2">
        <p className="eyebrow">Total stored</p>
        <p className="display mt-1" style={{ fontSize: "clamp(2rem,6vw,3rem)" }}>{formatBytes(insights.totalSize)}</p>
        <p className="t-sm mt-1" style={{ color: "var(--text-2)" }}>
          {insights.count} file{insights.count === 1 ? "" : "s"}
          {insights.trashCount ? ` · ${formatBytes(insights.trashSize)} recoverable in trash` : ""}
        </p>

        {total > 0 ? (
          <>
            <div className="mt-5 flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface)" }}>
              {insights.byType.map(t => (
                <motion.span
                  key={t.bucket}
                  initial={{ width: 0 }}
                  animate={{ width: `${(t.bytes / total) * 100}%` }}
                  transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  style={{ background: TYPE_COLORS[t.bucket] || "var(--text-3)" }}
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

export function SettingsPanel({
  theme,
  setTheme,
  link,
  onLinkChanged
}: {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  link: TelegramLink | null;
  onLinkChanged: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel p-5">
        <h2 className="display t-h2">Appearance</h2>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {([
            ["light", Sun, "Light"],
            ["dark", Moon, "Dark"],
            ["system", Monitor, "System"]
          ] as Array<[ThemeMode, typeof Sun, string]>).map(([value, Icon, label]) => (
            <button key={value} onClick={() => setTheme(value)} className={theme === value ? "btn btn-accent" : "btn btn-ghost"} style={{ minHeight: 44 }}>
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </section>

      <TelegramLinkCard link={link} onChanged={onLinkChanged} />

      <AiKeysCard />

      <AiModeCard />

      <AiToolsCard />

      <AiUsageCard />

      <section className="panel p-5 lg:col-span-2">
        <h2 className="display t-h2">Limits</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["Minimum file size", "1 byte"],
            ["Maximum file size", formatBytes(link?.maxBytes ?? MAX_FILE_SIZE)],
            ["Upload chunk", "4 MB"]
          ].map(([label, value]) => (
            <li key={label} className="rounded-xl p-3.5" style={{ background: "var(--surface)" }}>
              <p className="eyebrow">{label}</p>
              <p className="t-body mt-1 font-semibold" style={{ color: "var(--text-1)" }}>{value}</p>
            </li>
          ))}
        </ul>
        <p className="t-sm mt-3 leading-relaxed" style={{ color: "var(--text-3)" }}>
          Telegram sets these ceilings, not TeleDrive. Bot storage chunks every file at 4 MB so it stays under the
          Bot API&apos;s 20 MB download limit; linking your own account stores big files as a single message instead.
        </p>
      </section>
    </div>
  );
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
function AiToolsCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [rules, setRules] = useState<AutomationRow[]>([]);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ fileId: string; fileName: string; score: number; excerpt: string }> | null>(null);
  const [searching, setSearching] = useState(false);

  const [name, setName] = useState("");
  const [mimePrefix, setMimePrefix] = useState("image/");
  const [stepType, setStepType] = useState("ocr");

  const load = useCallback(() => {
    apiFetch<{ automations: AutomationRow[] }>("/api/ai/automations")
      .then(d => {
        setRules(d.automations);
        setAvailable(true);
      })
      .catch(err => {
        setAvailable(false);
        if (!(err instanceof ApiError && err.status === 404)) toast.error("Could not load automations.");
      });
  }, []);
  useEffect(load, [load]);

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
      load();
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
      load();
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
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the rule.");
    } finally {
      setBusy(false);
    }
  };

  if (available !== true) return null;

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
function AiModeCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [modes, setModes] = useState<string[]>([]);
  const [mode, setMode] = useState("hybrid");
  const [strategy, setStrategy] = useState("priority");
  const [overrides, setOverrides] = useState<Record<string, { mode?: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ preferences: { mode: string; strategy: string; taskOverrides: Record<string, { mode?: string }> }; modes: string[] }>(
      "/api/ai/settings"
    )
      .then(d => {
        if (cancelled) return;
        setMode(d.preferences.mode);
        setStrategy(d.preferences.strategy);
        setOverrides(d.preferences.taskOverrides || {});
        setModes(d.modes);
        setAvailable(true);
      })
      .catch(err => {
        if (cancelled) return;
        setAvailable(false);
        if (!(err instanceof ApiError && err.status === 404)) toast.error("Could not load AI settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (available !== true) return null;

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
function AiUsageCard() {
  const [data, setData] = useState<AiUsage | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AiUsage>(`/api/ai/usage?days=${days}`)
      .then(d => {
        if (cancelled) return;
        setData(d);
        setAvailable(true);
      })
      .catch(err => {
        if (cancelled) return;
        setAvailable(false);
        if (!(err instanceof ApiError && err.status === 404)) toast.error("Could not load AI usage.");
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  if (available !== true || !data) return null;

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
function AiKeysCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [keys, setKeys] = useState<AiKeyRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [provider, setProvider] = useState("");
  const [nickname, setNickname] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const load = useCallback(() => {
    apiFetch<{ providers: AiProvider[]; keys: AiKeyRow[] }>("/api/ai/keys")
      .then(d => {
        setProviders(d.providers);
        setKeys(d.keys);
        setAvailable(true);
        setProvider(p => p || d.providers[0]?.id || "");
      })
      .catch(err => {
        // 404 is the feature being switched off, not a failure worth reporting.
        if (err instanceof ApiError && err.status === 404) setAvailable(false);
        else {
          setAvailable(false);
          toast.error("Could not load AI keys.");
        }
      });
  }, []);

  useEffect(load, [load]);

  const spec = providers.find(p => p.id === provider) || null;

  const submit = async () => {
    if (!apiKey.trim() || !model.trim()) {
      toast.error("A key and a model are both required.");
      return;
    }
    setAdding(true);
    try {
      await apiFetch("/api/ai/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          nickname: nickname.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          baseUrl: baseUrl.trim() || null
        })
      });
      // Clear the secret from component state the moment it is stored.
      setApiKey("");
      setNickname("");
      setModel("");
      setBaseUrl("");
      toast.success("Key saved.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the key.");
    } finally {
      setAdding(false);
    }
  };

  const patch = async (row: AiKeyRow, body: Record<string, unknown>) => {
    setBusy(row.id);
    try {
      await apiFetch(`/api/ai/keys/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      load();
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
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the key.");
    } finally {
      setBusy(null);
    }
  };

  // Hidden entirely until the server says the feature exists.
  if (available !== true) return null;

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

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="eyebrow">Provider</span>
          <select value={provider} onChange={e => setProvider(e.target.value)} className="field" style={{ minHeight: 44 }}>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>

        <label className="grid gap-1">
          <span className="eyebrow">Name</span>
          <input value={nickname} onChange={e => setNickname(e.target.value)} placeholder={spec?.label || "My key"} className="field" style={{ minHeight: 44 }} />
        </label>

        <label className="grid gap-1">
          <span className="eyebrow">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={spec?.local ? "any value your runtime accepts" : "sk-…"}
            autoComplete="off"
            className="field"
            style={{ minHeight: 44 }}
          />
        </label>

        <label className="grid gap-1">
          <span className="eyebrow">Model</span>
          <input value={model} onChange={e => setModel(e.target.value)} placeholder="model name" className="field" style={{ minHeight: 44 }} />
        </label>

        {/* Shown for every provider: a hosted key may also need a proxy URL. */}
        <label className="grid gap-1 sm:col-span-2">
          <span className="eyebrow">
            Base URL {spec?.requiresBaseUrl ? "(required)" : "(optional — overrides the default)"}
          </span>
          <input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder={spec?.defaultBaseUrl || "http://localhost:11434/v1"}
            className="field"
            style={{ minHeight: 44 }}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={submit} disabled={adding} className="btn btn-accent" style={{ minHeight: 44 }}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          Save key
        </button>
        {spec?.keysUrl && (
          <a href={spec.keysUrl} target="_blank" rel="noreferrer" className="t-sm underline" style={{ color: "var(--text-3)" }}>
            Get a {spec.label} key
          </a>
        )}
      </div>
    </section>
  );
}

/** Link the user's own Telegram account over MTProto (QR or phone code). */
function TelegramLinkCard({ link, onChanged }: { link: TelegramLink | null; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "qr" | "phone">("idle");
  const [qrUrl, setQrUrl] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"start" | "code" | "password">("start");
  const [busy, setBusy] = useState(false);

  const post = useCallback(async (body: Record<string, unknown>) => {
    return apiFetch<{ status?: string; qrUrl?: string; premium?: boolean; name?: string }>("/api/telegram/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }, []);

  // Poll while a QR code is on screen; Telegram answers once it's scanned.
  useEffect(() => {
    if (mode !== "qr" || !qrUrl) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await post({ action: "qr-poll" });
        if (cancelled) return;
        if (result.status === "linked") {
          toast.success(`Telegram account linked${result.premium ? " (Premium — 4 GB files)" : ""}`);
          setMode("idle");
          setQrUrl("");
          onChanged();
        } else if (result.status === "password") {
          setStep("password");
          setMode("phone");
          setQrUrl("");
        }
      } catch {
        /* keep polling — the token is valid for ~30s and we re-issue below */
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [mode, qrUrl, post, onChanged]);

  if (!link) return <section className="panel p-5"><PanelSkeleton rows={1} /></section>;

  if (!link.available) {
    return (
      <section className="panel p-5">
        <h2 className="display t-h2">Large files</h2>
        <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-2)" }}>
          This server has no Telegram <span className="mono">API_ID</span> / <span className="mono">API_HASH</span>, so
          account linking is unavailable. Bot storage still handles files up to {formatBytes(MAX_FILE_SIZE)}.
        </p>
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
          <div className="mt-3 flex gap-2">
            <button className="btn btn-ghost" onClick={() => { setMode("idle"); setQrUrl(""); }}>Cancel</button>
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
                      await post({ action: "phone-start", phone: phone.replace(/\s/g, "") });
                      setStep("code");
                      toast.success("Telegram sent you a code.");
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

export function AboutPanel({ maxBytes }: { maxBytes: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel p-6">
        <h2 className="display t-h2">TeleDrive</h2>
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
