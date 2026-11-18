"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { nativeDirectBackup } from "@/lib/native-direct-backup";
import { toast } from "sonner";
import {
  AlertCircle, ArrowRight, BatteryCharging, Camera, Check, CheckCircle2, Clock, Cloud, Film, Folder as FolderIcon,
  Image as ImageIcon, Images, Loader2, MessageCircle, Monitor, Power, RefreshCw, RotateCcw, Search, SkipForward,
  Smartphone, Square, Wifi, Zap
} from "lucide-react";
import { nativeBackup, nativeBackupAvailable, vendorAdvice, type NativeAlbum, type NativeBackupStatus } from "@/lib/native-backup";
import { formatBytes } from "@/lib/utils";
import { DirectBackupControls } from "./direct-backup-controls";
import { BackupFiles } from "./backup-controls";
import { DestinationTile, FolderPicker, folderTrail, useFolders } from "./folder-picker";

/* ── Small visual parts ─────────────────────────────────────────────────────── */

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onChange} disabled={disabled}
            className="relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50"
            style={{ background: on ? "var(--accent)" : "var(--border-med)" }}>
      <span className="absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all" style={{ left: on ? 22 : 2 }} />
    </button>
  );
}

function Stat({ icon: Icon, value, label, tone }: { icon: typeof Clock; value: string; label: string; tone?: string }) {
  return (
    <div className="rounded-2xl p-3" style={{ background: "var(--surface)", border: "1px solid var(--border-dim)" }}>
      <Icon className="h-4 w-4" style={{ color: tone ?? "var(--accent)" }} />
      <p className="display mt-2 text-xl leading-none" style={{ color: "var(--text-1)" }}>{value}</p>
      <p className="t-xs mt-1" style={{ color: "var(--text-3)" }}>{label}</p>
    </div>
  );
}

function Segment<T extends string | number>({ value, options, onChange, disabled }: {
  value: T; options: Array<{ value: T; label: string; icon?: typeof Clock }>; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl p-1" style={{ background: "var(--surface)" }}>
      {options.map(o => (
        <button key={String(o.value)} disabled={disabled} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
                className="t-xs flex min-h-[36px] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 font-semibold transition disabled:opacity-50"
                style={value === o.value ? { background: "var(--surface-hi)", color: "var(--text-1)" } : { color: "var(--text-3)" }}>
          {o.icon ? <o.icon className="h-4 w-4" /> : null}{o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="t-sm flex items-center gap-2 font-semibold" style={{ color: "var(--text-1)" }}>
        <Icon className="h-4 w-4" style={{ color: "var(--accent)" }} /> {title}
      </p>
      {children}
    </div>
  );
}

/** A recognisable icon and colour for a phone album, from its name. */
function albumLook(album: NativeAlbum): { icon: typeof Clock; hue: number } {
  const n = `${album.path} ${album.name}`.toLowerCase();
  if (/camera|dcim/.test(n)) return { icon: Camera, hue: 200 };
  if (/screenshot|screen/.test(n)) return { icon: Monitor, hue: 265 };
  if (/whatsapp|telegram|instagram|messenger|snapchat/.test(n)) return { icon: MessageCircle, hue: 145 };
  if (album.videos > album.photos) return { icon: Film, hue: 335 };
  if (/download/.test(n)) return { icon: ArrowRight, hue: 30 };
  let h = 0;
  for (const c of album.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { icon: ImageIcon, hue: h };
}

/* ── The hub ────────────────────────────────────────────────────────────────── */

/**
 * Photo and video backup for the Android app, laid out to be read at a glance:
 * a status header, where files go, which albums (each can have its own folder),
 * and the rules. Rendered as nothing outside the app.
 */
export function PhotoBackupHub({ user }: { user: string }) {
  const available = nativeBackupAvailable();
  const [status, setStatus] = useState<NativeBackupStatus | null>(null);
  const [albums, setAlbums] = useState<NativeAlbum[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [pickFor, setPickFor] = useState<NativeAlbum | null>(null);
  const { folders, reload } = useFolders();
  const directRun = useSyncExternalStore(nativeDirectBackup.subscribe, nativeDirectBackup.getSnapshot, nativeDirectBackup.getServerSnapshot);
  const directRunning = directRun.running && directRun.user === user;
  // Either route counts: the direct run lives in the page, not in the native worker.
  const running = (status?.running ?? false) || directRunning;

  const refresh = useCallback(async () => {
    const next = await nativeBackup.status();
    if (next) setStatus(next);
  }, []);

  useEffect(() => {
    if (!available) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), running ? 1_500 : 10_000);
    return () => window.clearInterval(timer);
  }, [available, refresh, running]);

  useEffect(() => {
    if (!available || !status?.mediaPermission) return;
    let cancelled = false;
    void nativeBackup.albums().then(result => { if (!cancelled) setAlbums(result?.albums ?? []); });
    return () => { cancelled = true; };
  }, [available, status?.mediaPermission]);

  const apply = useCallback(async (action: () => Promise<NativeBackupStatus | null>, success?: string) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) { setStatus(next); if (success) toast.success(success); }
      else toast.error("The app refused that. Check its permissions in Android settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  const selected = useMemo(
    () => status && status.albums.length ? status.albums : (albums ?? []).filter(a => a.selected).map(a => a.path),
    [status, albums]
  );

  const toggleAlbum = useCallback((path: string) => {
    const next = selected.includes(path) ? selected.filter(p => p !== path) : [...selected, path];
    if (!next.length) { toast.error("Keep at least one album, or turn backup off."); return; }
    void apply(() => nativeBackup.setOptions({ albums: next }));
  }, [selected, apply]);

  const setAlbumFolder = useCallback((album: NativeAlbum, id: string | null) => {
    const map = { ...(status?.albumFolders ?? {}) };
    if (id && id !== status?.folderId) map[album.path] = id; else delete map[album.path];
    void apply(() => nativeBackup.setOptions({ albumFolders: map }), id ? `${album.name} has its own folder now.` : `${album.name} uses the main folder.`);
  }, [status, apply]);

  if (!available) return null;
  if (!status) {
    return <section className="panel grid place-items-center p-10"><Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--accent)" }} /></section>;
  }

  const supportsAlbumFolders = "albumFolders" in status;
  const direct = status.transport === "direct";
  const percent = status.currentSize > 0 ? Math.min(100, Math.round((status.currentSent / status.currentSize) * 100)) : 0;
  const lastRun = status.lastRunAt ? new Date(status.lastRunAt) : null;
  const advice = vendorAdvice(status.vendor);
  const mainName = status.folderId ? (folders && folderTrail(status.folderId, folders).at(-1)?.name) || status.folderName || "Chosen folder" : "Camera backup";

  const visibleAlbums = (albums ?? [])
    .filter(a => showAll || selected.includes(a.path))
    .filter(a => !query.trim() || a.name.toLowerCase().includes(query.trim().toLowerCase()));

  const stateLook = !status.enabled
    ? { title: "Backup is off", sub: "Turn it on to save new photos and videos automatically.", color: "var(--text-3)", icon: Power }
    : running
      ? { title: "Backing up…", sub: (directRunning ? directRun.name : status.currentName) || "Working through your albums", color: "var(--accent)", icon: RefreshCw }
      : status.pending > 0
        ? { title: `${status.pending.toLocaleString()} waiting`, sub: direct ? "Tap Back up directly now and keep the app open." : "They go up on the next scheduled run.", color: "#f5a524", icon: Clock }
        : { title: "All backed up", sub: lastRun ? `Last checked ${lastRun.toLocaleString()}` : "Nothing waiting.", color: "var(--emerald)", icon: CheckCircle2 };

  return (
    <div className="space-y-4">
      {/* ── Status ─────────────────────────────────────────────────────── */}
      <section className="panel overflow-hidden p-0">
        <div className="p-5" style={{ background: "linear-gradient(135deg,var(--accent-dim),transparent 70%)" }}>
          <div className="flex items-center gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl"
                  style={{ background: "var(--bg-1)", border: `2px solid ${stateLook.color}`, color: stateLook.color }}>
              <stateLook.icon className={`h-7 w-7 ${running ? "animate-spin" : ""}`} style={running ? { animationDuration: "2.5s" } : undefined} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Photo &amp; video backup</p>
              <h2 className="display text-xl leading-tight" style={{ color: "var(--text-1)" }}>{stateLook.title}</h2>
              <p className="t-xs mt-0.5 line-clamp-2" style={{ color: "var(--text-3)" }}>{stateLook.sub}</p>
            </div>
            <Toggle label="Photo and video backup" on={status.enabled}
                    disabled={busy || (!status.enabled && (status.backupVersion ?? 0) < 2)}
                    onChange={() => void apply(status.enabled ? nativeBackup.disable : nativeBackup.enable, status.enabled ? "Backup is off." : "Backup is on.")} />
          </div>

          {status.running && status.currentName ? (
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--border-dim)" }}>
                <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${percent}%`, background: "linear-gradient(90deg,var(--accent),var(--accent-2))" }} />
              </div>
              <div className="mono t-xs mt-1.5 flex justify-between" style={{ color: "var(--text-3)" }}>
                <span>{formatBytes(status.currentSent)} / {formatBytes(status.currentSize)}</span>
                {status.currentTotal ? <span>{status.currentIndex} of {status.currentTotal}</span> : null}
              </div>
              <div className="mt-2 flex gap-2">
                <button className="btn btn-ghost" style={{ minHeight: 32, fontSize: 12 }} disabled={busy}
                        onClick={() => void apply(nativeBackup.skipCurrent, "Skipping that one.")}><SkipForward className="h-3.5 w-3.5" /> Skip file</button>
                <button className="btn btn-ghost" style={{ minHeight: 32, fontSize: 12 }} disabled={busy}
                        onClick={() => void apply(nativeBackup.stopRun, "Stopped. The next scheduled run still happens.")}><Square className="h-3.5 w-3.5" /> Stop</button>
              </div>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-3 gap-2">
            <Stat icon={Clock} value={status.pending < 0 ? "–" : status.pending.toLocaleString()} label="Waiting" tone="#f5a524" />
            <Stat icon={Check} value={status.uploadedTotal.toLocaleString()} label="Saved" tone="var(--emerald)" />
            <Stat icon={AlertCircle} value={String(status.problemCount)} label="Problems" tone={status.problemCount ? "var(--danger)" : "var(--text-3)"} />
          </div>
        </div>

        {/* Route: two big choices instead of a dropdown. */}
        <div className="grid gap-2 p-5 pt-4 sm:grid-cols-2">
          {([
            ["direct", Zap, "Direct to Telegram", "Fastest. Keep the app open while it runs."],
            ["relay", Cloud, "In the background", "Runs on a schedule, even when the app is closed."]
          ] as const).map(([value, Icon, title, sub]) => {
            const active = (value === "direct") === direct;
            return (
              <button key={value} disabled={busy || (status.backupVersion ?? 0) < 3}
                      onClick={() => !active && void apply(() => nativeBackup.setOptions({ transport: value }), "Backup route updated.")}
                      className="flex items-start gap-3 rounded-2xl p-3 text-left transition"
                      style={{ background: active ? "var(--accent-dim)" : "var(--surface)", border: `1px solid ${active ? "var(--accent-border)" : "var(--border-dim)"}` }}>
                <Icon className="mt-0.5 h-5 w-5 shrink-0" style={{ color: active ? "var(--accent)" : "var(--text-3)" }} />
                <span className="min-w-0">
                  <span className="t-sm block font-semibold" style={{ color: "var(--text-1)" }}>{title}</span>
                  <span className="t-xs block" style={{ color: "var(--text-3)" }}>{sub}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="px-5 pb-5">
          {direct ? (
            <DirectBackupControls user={user} status={status} busy={busy}
                                  onRescan={() => void apply(nativeBackup.rescanAll, "Selected albums will be checked again.")} />
          ) : status.enabled ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-accent" disabled={busy || running} onClick={() => void apply(nativeBackup.runNow, "Looking for new photos now.")}>
                <RefreshCw className="h-4 w-4" /> Back up now
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void apply(nativeBackup.rescanAll, "Re-checking the whole camera roll.")}>
                <RotateCcw className="h-4 w-4" /> Re-check everything
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Phone needs a hand ─────────────────────────────────────────── */}
      {status.enabled && (!status.batteryExempt || status.needsStartupPermission || !status.notificationPermission) ? (
        <section className="panel p-4" style={{ borderColor: "rgba(245,165,36,0.4)", background: "rgba(245,165,36,0.06)" }}>
          <p className="t-sm flex items-center gap-2 font-semibold" style={{ color: "#f5a524" }}>
            <BatteryCharging className="h-4 w-4" /> Let backup run in the background
          </p>
          {advice ? (
            <ul className="t-xs mt-2 list-disc space-y-1 pl-5" style={{ color: "var(--text-2)" }}>
              {advice.steps.map(step => <li key={step}>{step}</li>)}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!status.batteryExempt ? <button className="btn btn-ghost" style={{ minHeight: 32, fontSize: 12 }} onClick={() => void apply(nativeBackup.requestBatteryExemption)}><Power className="h-3.5 w-3.5" /> Allow background</button> : null}
            {status.needsStartupPermission ? <button className="btn btn-ghost" style={{ minHeight: 32, fontSize: 12 }} onClick={async () => {
              const result = await nativeBackup.openStartupSettings();
              if (!result?.opened) toast("Opened TeleDrive's app settings. Use the steps above for auto-launch.");
            }}><Smartphone className="h-3.5 w-3.5" /> App settings</button> : null}
            {!status.notificationPermission ? <button className="btn btn-ghost" style={{ minHeight: 32, fontSize: 12 }} onClick={() => void apply(nativeBackup.requestNotificationPermission)}><AlertCircle className="h-3.5 w-3.5" /> Allow notification</button> : null}
          </div>
        </section>
      ) : null}

      {/* ── Where it goes ──────────────────────────────────────────────── */}
      <section className="panel space-y-3 p-5">
        <h3 className="display t-h3">Where backups go</h3>
        <DestinationTile label="Main backup folder" value={status.folderId} automaticName="Camera backup" folders={folders} onReload={reload}
                         onChange={(id, name) => void apply(() => nativeBackup.setOptions({ folderId: id, folderName: name }), `Backups go to ${name}.`)} />
        {supportsAlbumFolders ? (
          <p className="t-xs" style={{ color: "var(--text-3)" }}>Albums use this folder unless you give one its own below.</p>
        ) : (
          <p className="t-xs" style={{ color: "var(--text-3)" }}>Install the latest app to send each album to its own folder.</p>
        )}
      </section>

      {/* ── Albums ─────────────────────────────────────────────────────── */}
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="display t-h3">Albums</h3>
            <p className="t-xs" style={{ color: "var(--text-3)" }}>{selected.length} selected{albums ? ` of ${albums.length}` : ""} · tap to add or remove</p>
          </div>
          <Segment value={showAll ? "all" : "selected"} onChange={v => setShowAll(v === "all")}
                   options={[{ value: "selected", label: "Selected" }, { value: "all", label: "All" }]} />
        </div>
        {showAll && (albums?.length ?? 0) > 8 ? (
          <label className="field mt-3 flex items-center gap-2" style={{ minHeight: 40 }}>
            <Search className="h-4 w-4" style={{ color: "var(--text-3)" }} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find an album" aria-label="Find an album" className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
        ) : null}

        {!status.mediaPermission ? (
          <p className="t-sm mt-4" style={{ color: "var(--text-3)" }}>Turn backup on to let TeleDrive see your albums.</p>
        ) : albums === null ? (
          <p className="t-sm mt-4 flex items-center gap-2" style={{ color: "var(--text-3)" }}><Loader2 className="h-4 w-4 animate-spin" /> Reading your albums…</p>
        ) : visibleAlbums.length === 0 ? (
          <p className="t-sm mt-4" style={{ color: "var(--text-3)" }}>{showAll ? "No albums match." : "No albums selected — switch to All to pick some."}</p>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {visibleAlbums.map(album => {
              const on = selected.includes(album.path);
              const look = albumLook(album);
              const own = status.albumFolders?.[album.path];
              const ownName = own && folders ? folderTrail(own, folders).at(-1)?.name : null;
              return (
                <div key={album.path} className="relative overflow-hidden rounded-2xl transition"
                     style={{ background: "var(--surface)", border: `1px solid ${on ? "var(--accent-border)" : "var(--border-dim)"}`, opacity: on ? 1 : 0.75 }}>
                  <button onClick={() => toggleAlbum(album.path)} disabled={busy} aria-pressed={on}
                          className="block w-full p-3 text-left" title={album.path}>
                    <span className="grid h-11 w-11 place-items-center rounded-xl"
                          style={{ background: `linear-gradient(135deg,hsl(${look.hue} 80% 55%),hsl(${(look.hue + 40) % 360} 75% 45%))`, color: "#fff" }}>
                      <look.icon className="h-5 w-5" />
                    </span>
                    <span className="t-sm mt-2 block truncate font-semibold" style={{ color: "var(--text-1)" }}>{album.name}</span>
                    <span className="t-xs mt-0.5 flex items-center gap-2" style={{ color: "var(--text-3)" }}>
                      {album.photos ? <span className="flex items-center gap-0.5"><Images className="h-3 w-3" />{album.photos.toLocaleString()}</span> : null}
                      {album.videos ? <span className="flex items-center gap-0.5"><Film className="h-3 w-3" />{album.videos.toLocaleString()}</span> : null}
                    </span>
                    <span className="absolute right-2.5 top-2.5 grid h-6 w-6 place-items-center rounded-full"
                          style={on ? { background: "var(--accent)", color: "#fff" } : { border: "2px solid var(--border-med)" }}>
                      {on ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                  </button>
                  {on && supportsAlbumFolders ? (
                    <button onClick={() => setPickFor(album)} disabled={!folders}
                            className="t-xs flex w-full items-center gap-1.5 px-3 py-2 text-left"
                            style={{ borderTop: "1px solid var(--border-dim)", color: own ? "var(--accent)" : "var(--text-3)" }}>
                      <FolderIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{own ? ownName || "Own folder" : `→ ${mainName}`}</span>
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {pickFor && folders ? (
        <FolderPicker title={`Folder for ${pickFor.name}`} value={status.albumFolders?.[pickFor.path] ?? null}
                      automaticName={mainName} automaticHint="Same as the main backup folder" folders={folders} onReload={reload}
                      onClose={() => setPickFor(null)}
                      onPick={id => { const album = pickFor; setPickFor(null); setAlbumFolder(album, id); }} />
      ) : null}

      {/* ── Rules ──────────────────────────────────────────────────────── */}
      <section className="panel space-y-5 p-5">
        <h3 className="display t-h3">Rules</h3>
        <Row icon={Images} title="What to back up">
          <div className="flex flex-wrap gap-2">
            {([["includePhotos", "Photos", ImageIcon], ["includeVideos", "Videos", Film]] as const).map(([key, label, Icon]) => (
              <button key={key} disabled={busy} aria-pressed={status[key]}
                      onClick={() => void apply(() => nativeBackup.setOptions({ [key]: !status[key] }))}
                      className={status[key] ? "btn btn-accent" : "btn btn-ghost"}><Icon className="h-4 w-4" /> {label}</button>
            ))}
          </div>
        </Row>
        <Row icon={Wifi} title="Use which connection">
          <Segment disabled={busy} value={status.networkMode ?? (status.wifiOnly ? "wifi" : "both")}
                   onChange={value => void apply(() => nativeBackup.setOptions({ networkMode: value }))}
                   options={[{ value: "wifi", label: "Wi-Fi" }, { value: "mobile", label: "Mobile" }, { value: "both", label: "Both" }]} />
          <p className="t-xs" style={{ color: "var(--text-3)" }}>You are on {status.networkType ?? "an unknown connection"} now.</p>
        </Row>
        <Row icon={Film} title="Skip files larger than">
          <Segment disabled={busy} value={status.maxFileSizeMb}
                   onChange={value => void apply(() => nativeBackup.setOptions({ maxFileSizeMb: value }))}
                   options={[...new Set([0, 100, 500, 1024, 2048, status.maxFileSizeMb])].sort((a, b) => a - b)
                     .map(mb => ({ value: mb, label: mb === 0 ? "No limit" : mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB` }))} />
        </Row>
        {!direct ? (
          <Row icon={Clock} title="Check for new photos every">
            <Segment disabled={busy} value={status.intervalHours}
                     onChange={value => void apply(() => nativeBackup.setOptions({ intervalHours: value }))}
                     options={[1, 2, 6, 12, 24].map(h => ({ value: h, label: h === 24 ? "Day" : `${h}h` }))} />
          </Row>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="t-sm flex items-center gap-2 font-semibold"><BatteryCharging className="h-4 w-4" style={{ color: "var(--accent)" }} /> Only while charging</p>
          <Toggle label="Only while charging" on={status.chargingOnly} disabled={busy}
                  onChange={() => void apply(() => nativeBackup.setOptions({ chargingOnly: !status.chargingOnly }))} />
        </div>
      </section>

      <section className="panel p-5">
        <h3 className="display t-h3">Files and activity</h3>
        {lastRun ? <p className="t-xs mt-1" style={{ color: "var(--text-3)" }}>Last run {lastRun.toLocaleString()} — {status.lastResult || "no result recorded"}.</p> : null}
        <BackupFiles native user={user} folderId={status.folderId} />
      </section>
    </div>
  );
}
