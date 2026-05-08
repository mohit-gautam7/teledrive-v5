"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  File as FileIcon,
  Folder,
  Grid2X2,
  Home,
  Image,
  Link2,
  List,
  LogOut,
  Menu,
  MoreVertical,
  Monitor,
  Moon,
  Plus,
  RotateCw,
  Search,
  Settings,
  Star,
  Sun,
  Trash2,
  Upload,
  Video,
  X
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/button";
import { apiFetch, uploadFile } from "@/lib/api-client";
import { cn, formatBytes } from "@/lib/utils";

type DriveFile = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageMode: "BOT" | "PERSONAL";
  folderId: string | null;
  isFavorite: boolean;
  createdAt: string;
};

type DriveFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
};

type AppView = "home" | "files" | "shared" | "recent" | "favorites" | "trash" | "settings";
type ThemeMode = "light" | "dark" | "system";

export default function DriveApp({ user }: { user: { name: string; username?: string | null; avatar?: string | null } }) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderTrail, setFolderTrail] = useState<DriveFolder[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [appView, setAppView] = useState<AppView>("files");
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ id: string; name: string; size: number; percent: number; status: "uploading" | "done" | "error"; error?: string }[]>([]);
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [authStatus, setAuthStatus] = useState<"connected" | "pending" | "failed">("pending");

  const refresh = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (folderId) params.set("folderId", folderId);
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (appView === "recent" || appView === "favorites" || appView === "trash") params.set("view", appView);
    try {
      const [fileData, folderData] = await Promise.all([
        apiFetch<{ files: DriveFile[] }>(`/api/files?${params}`, { cache: "no-store" }),
        appView === "shared" || appView === "recent" || appView === "favorites" || appView === "trash"
          ? Promise.resolve({ folders: [] as DriveFolder[] })
          : apiFetch<{ folders: DriveFolder[] }>(`/api/folders?${folderId ? `parentId=${folderId}` : ""}`, { cache: "no-store" })
      ]);
      setFiles(fileData.files);
      setFolders(folderData.folders);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load files.");
    } finally {
      setLoading(false);
    }
  }, [folderId, debouncedQuery, appView]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const saved = (window.localStorage.getItem("teledrive-theme") as ThemeMode | null) || "system";
    setTheme(saved);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const shouldDark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", shouldDark);
    };
    applyTheme();
    window.localStorage.setItem("teledrive-theme", theme);
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    apiFetch<{ user: unknown }>("/api/auth/me")
      .then(data => setAuthStatus(data.user ? "connected" : "failed"))
      .catch(() => setAuthStatus("failed"));
  }, []);

  const uploadFiles = useCallback(
    async (acceptedFiles: File[]) => {
      const maxSize = 2 * 1024 * 1024 * 1024;
      const tooLarge = acceptedFiles.find(f => f.size > maxSize);
      if (tooLarge) {
        toast.error(`"${tooLarge.name}" exceeds Telegram's 2 GB file limit.`);
        return;
      }
      const items = acceptedFiles.map(f => ({ id: Math.random().toString(36).slice(2), name: f.name, size: f.size, percent: 0, status: "uploading" as const }));
      setUploadQueue(items);
      setUploading(true);
      let anyError = false;
      for (let i = 0; i < acceptedFiles.length; i++) {
        const file = acceptedFiles[i];
        const itemId = items[i].id;
        try {
          const form = new FormData();
          form.append("file", file);
          if (folderId) form.append("folderId", folderId);
          await uploadFile<{ routing: { storageMode: "BOT" | "PERSONAL" } }>("/api/upload", form, percent => {
            setUploadQueue(q => q.map(it => it.id === itemId ? { ...it, percent } : it));
          });
          setUploadQueue(q => q.map(it => it.id === itemId ? { ...it, percent: 100, status: "done" } : it));
        } catch (error) {
          anyError = true;
          const msg = error instanceof Error ? error.message : "Upload failed";
          setUploadQueue(q => q.map(it => it.id === itemId ? { ...it, status: "error", error: msg } : it));
        }
      }
      await refresh();
      setUploading(false);
      if (!anyError) {
        setTimeout(() => setUploadQueue([]), 2500);
      }
    },
    [folderId, refresh]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: uploadFiles,
    noClick: true,
    multiple: true
  });

  const storageUsed = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  async function createFolder() {
    const name = prompt("Folder name");
    if (!name) return;
    try {
      await apiFetch("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId: folderId })
      });
      toast.success("Folder created");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create folder.");
    }
  }

  async function shareFile(fileId: string) {
    try {
      const data = await apiFetch<{ shareUrl: string }>("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId })
      });
      await navigator.clipboard.writeText(`${window.location.origin}${data.shareUrl}`);
      toast.success("Share link copied");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Share failed.");
    }
  }

  async function deleteFile(fileId: string) {
    const inTrash = appView === "trash";
    const msg = inTrash
      ? "Permanently delete this file? This cannot be undone."
      : "Move this file to trash?";
    if (!confirm(msg)) return;
    try {
      await apiFetch(`/api/files/${fileId}`, { method: "DELETE" });
      toast.success(inTrash ? "File permanently deleted" : "File moved to trash");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete file.");
    }
  }

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/";
    }
  }

  function enterFolder(folder: DriveFolder) {
    setFolderTrail(current => [...current, folder]);
    setFolderId(folder.id);
  }

  function goHome() {
    setFolderTrail([]);
    setFolderId(null);
    setAppView("files");
  }

  const navItems = [
    { icon: Home, label: "Home", view: "home" as AppView },
    { icon: Folder, label: "My Files", view: "files" as AppView },
    { icon: Link2, label: "Shared", view: "shared" as AppView },
    { icon: Star, label: "Favorites", view: "favorites" as AppView },
    { icon: Trash2, label: "Trash", view: "trash" as AppView },
    { icon: Settings, label: "Settings", view: "settings" as AppView }
  ];

  function selectView(nextView: AppView) {
    setAppView(nextView);
    setSidebarOpen(false);
    if (nextView !== "settings") {
      setFolderId(null);
      setFolderTrail([]);
    }
    if (nextView === "shared") toast.info("Shared file management is coming next. Public links already work from file cards.");
  }

  return (
    <div
      {...getRootProps()}
      className="min-h-screen text-[var(--text-primary)]"
      style={{ background: "linear-gradient(-45deg,#070d1a,#0a1128,#070d1a,#0d1829)", backgroundSize: "400% 400%", animation: "bgmove 20s ease infinite" }}
    >
      <input {...getInputProps()} />
      {sidebarOpen ? <button className="fixed inset-0 z-30 bg-black/50 lg:hidden" style={{ backdropFilter: "blur(2px)" }} aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} /> : null}

      {/* ── Sidebar ── */}
      <motion.aside
        initial={{ x: -24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-72 flex-col border-r px-4 py-5 transition md:w-72",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
        style={{ borderColor: "rgba(0,212,255,0.12)", background: "rgba(7,13,26,0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
      >
        {/* Logo */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-lg font-bold tracking-wide">
            <div className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "linear-gradient(135deg,#00d4ff,#0284c7)", boxShadow: "0 0 18px rgba(0,212,255,0.4)" }}>
              <CloudIcon />
            </div>
            <span style={{ background: "linear-gradient(90deg,#fff,#00d4ff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>TeleDrive</span>
          </div>
          <button className="lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" style={{ color: "#64748b" }}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Upload button */}
        <button
          onClick={open}
          disabled={uploading}
          className="btn-ripple mt-7 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl font-semibold text-sm transition active:scale-[0.96] disabled:opacity-60"
          style={{ background: "linear-gradient(135deg,#00d4ff,#0284c7)", color: "#fff", boxShadow: "0 0 18px rgba(0,212,255,0.35)", cursor: uploading ? "not-allowed" : "pointer" }}
        >
          <Upload className="h-4 w-4" />
          {uploading ? "Uploading…" : "Upload"}
        </button>

        <AnimatePresence>
          {uploadQueue.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 overflow-hidden rounded-xl border"
              style={{ borderColor: "rgba(0,212,255,0.15)", background: "rgba(0,212,255,0.04)" }}
            >
              <div className="max-h-52 overflow-y-auto p-2 space-y-1.5">
                {uploadQueue.map(item => (
                  <div key={item.id} className="rounded-lg p-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
                    <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
                      <span className="truncate font-medium" style={{ color: "#e2e8f0", maxWidth: "75%" }}>{item.name}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {item.status === "uploading" && <span style={{ color: "#00d4ff" }}>{item.percent}%</span>}
                        {item.status === "done" && <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "#34d399" }} />}
                        {item.status === "error" && (
                          <button onClick={() => setUploadQueue(q => q.filter(it => it.id !== item.id))}>
                            <X className="h-3.5 w-3.5" style={{ color: "#f87171" }} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.07)" }}>
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: item.status === "error" ? "#f87171" : item.status === "done" ? "#34d399" : "linear-gradient(90deg,#00d4ff,#0284c7)" }}
                        initial={{ width: 0 }}
                        animate={{ width: `${item.status === "done" ? 100 : item.percent}%` }}
                        transition={{ ease: "easeOut" }}
                      />
                    </div>
                    {item.status === "error" && <p className="mt-1 text-xs truncate" style={{ color: "#f87171" }}>{item.error}</p>}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Nav */}
        <nav className="mt-6 flex-1 space-y-1 overflow-y-auto pb-4">
          {navItems.map(({ icon: Icon, label, view: itemView }) => {
            const active = appView === itemView;
            return (
              <button
                key={label}
                onClick={() => selectView(itemView)}
                className={cn("nav-item-drive relative flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-sm transition focus:outline-none")}
                style={{
                  color: active ? "#00d4ff" : "#64748b",
                  background: active ? "rgba(0,212,255,0.08)" : "transparent",
                  border: active ? "1px solid rgba(0,212,255,0.2)" : "1px solid transparent",
                }}
              >
                {active ? <motion.span layoutId="nav-active" className="absolute left-0 h-6 w-1 rounded-r-full" style={{ background: "#00d4ff", boxShadow: "0 0 8px #00d4ff" }} /> : null}
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </nav>

        {/* User card — mt-auto keeps it at bottom without absolute overlap */}
        <div className="mt-auto rounded-xl border p-4" style={{ borderColor: "rgba(0,212,255,0.12)", background: "rgba(0,212,255,0.04)" }}>
          <p className="text-sm font-semibold" style={{ color: "#e2e8f0" }}>{user.name}</p>
          <p className="truncate text-xs" style={{ color: "#475569" }}>{user.username ? `@${user.username}` : "Telegram account"}</p>
          <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: "#64748b" }}>
            {authStatus === "connected" ? <CheckCircle2 className="h-4 w-4" style={{ color: "#34d399" }} /> : authStatus === "failed" ? <AlertCircle className="h-4 w-4" style={{ color: "#f87171" }} /> : <RotateCw className="h-4 w-4 animate-spin" style={{ color: "#00d4ff" }} />}
            <span>{authStatus === "connected" ? "Connected" : authStatus === "failed" ? "Reconnect needed" : "Checking…"}</span>
          </div>
          <p className="mt-3 text-xs" style={{ color: "#475569" }}>Storage used</p>
          <p className="text-sm font-bold" style={{ color: "#00d4ff" }}>{formatBytes(storageUsed)}</p>
        </div>
      </motion.aside>

      {/* ── Main ── */}
      <motion.main className="lg:pl-72" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
        {/* Header */}
        <header className="sticky top-0 z-30" style={{ background: "rgba(7,13,26,0.88)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: "1px solid rgba(0,212,255,0.1)" }}>
          <div className="flex min-h-14 items-center gap-2 px-3 md:min-h-16 md:gap-3 md:px-6">
            <button className="grid h-11 w-11 place-items-center rounded-xl lg:hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }} onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Menu className="h-5 w-5" />
            </button>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "#475569" }} />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search files…"
                style={{ cursor: "text", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e2e8f0", borderRadius: 12 }}
                className="h-11 w-full pl-10 pr-3 text-sm outline-none transition focus:border-[#00d4ff] focus:ring-2 focus:ring-[rgba(0,212,255,0.15)]"
              />
            </div>
            <button
              onClick={() => setTheme(current => (current === "system" ? "light" : current === "light" ? "dark" : "system"))}
              className="grid h-11 w-11 place-items-center rounded-xl transition hover:text-[#00d4ff] active:scale-[0.96]"
              style={{ border: "1px solid rgba(255,255,255,0.08)" }}
              aria-label="Toggle theme"
            >
              {theme === "system" ? <Monitor className="h-4 w-4" /> : theme === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              onClick={logout}
              className="grid h-11 w-11 place-items-center rounded-xl transition hover:text-red-400 active:scale-[0.96]"
              style={{ border: "1px solid rgba(255,255,255,0.08)" }}
              aria-label="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <section className="px-4 py-6 md:px-6">
          <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: "#475569" }}>
                <button onClick={goHome} className="transition hover:text-[#00d4ff]">My Files</button>
                {folderTrail.map(folder => (
                  <span key={folder.id} className="flex items-center gap-2">
                    <span>/</span>
                    <span style={{ color: "#94a3b8" }}>{folder.name}</span>
                  </span>
                ))}
              </div>
              <h1 className="mt-2 text-xl font-bold md:text-2xl" style={{ color: "#e2e8f0" }}>
                {appView === "settings" ? "Settings" : appView === "trash" ? "Trash" : appView === "favorites" ? "Favorites" : appView === "shared" ? "Shared" : "Personal cloud storage"}
              </h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={createFolder}
                disabled={appView === "settings" || appView === "trash" || appView === "shared"}
                className="btn-ripple flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition active:scale-[0.96] disabled:opacity-40"
                style={{ border: "1px solid rgba(0,212,255,0.3)", color: "#00d4ff", background: "rgba(0,212,255,0.06)" }}
              >
                <Plus className="h-4 w-4" /> Folder
              </button>
              <button
                onClick={() => setView("grid")}
                className="grid h-10 w-10 place-items-center rounded-xl transition active:scale-[0.96]"
                style={{ border: `1px solid ${view === "grid" ? "#00d4ff" : "rgba(255,255,255,0.08)"}`, background: view === "grid" ? "rgba(0,212,255,0.12)" : "transparent", color: view === "grid" ? "#00d4ff" : "#64748b" }}
              >
                <Grid2X2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView("list")}
                className="grid h-10 w-10 place-items-center rounded-xl transition active:scale-[0.96]"
                style={{ border: `1px solid ${view === "list" ? "#00d4ff" : "rgba(255,255,255,0.08)"}`, background: view === "list" ? "rgba(0,212,255,0.12)" : "transparent", color: view === "list" ? "#00d4ff" : "#64748b" }}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {appView === "settings" ? (
            <SettingsPanel theme={theme} setTheme={setTheme} authStatus={authStatus} />
          ) : (
          <>
            {/* Drop zone */}
            <div
              className={cn("mb-6 rounded-2xl border-2 border-dashed transition", isDragActive && "dropzone-active scale-[1.01]")}
              style={{ borderColor: isDragActive ? "#00d4ff" : "rgba(0,212,255,0.2)", background: isDragActive ? "rgba(0,212,255,0.06)" : "rgba(0,212,255,0.02)", cursor: "crosshair", padding: "clamp(1rem,4vw,2.5rem)", textAlign: "center" }}
            >
              <Upload className="mx-auto mb-2 h-7 w-7" style={{ color: "#00d4ff" }} />
              <p className="font-semibold text-sm md:text-base" style={{ color: "#e2e8f0" }}>Drop files or folders here</p>
              <p className="mt-0.5 text-xs md:text-sm" style={{ color: "#475569" }}>Auto-routes large files to Telegram storage.</p>
            </div>

            {/* Folders */}
            {folders.length > 0 ? (
              <div className="mb-8 grid gap-3 grid-cols-2 sm:grid-cols-2 xl:grid-cols-4">
                {folders.map(folder => (
                  <motion.button
                    key={folder.id}
                    layout
                    whileHover={{ y: -4, scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => enterFolder(folder)}
                    className="drive-card flex items-center gap-3 rounded-xl border p-4 text-left transition"
                    style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", cursor: "pointer" }}
                  >
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.2)" }}>
                      <Folder className="h-5 w-5" style={{ color: "#fbbf24" }} />
                    </div>
                    <span className="truncate text-sm font-semibold" style={{ color: "#e2e8f0" }}>{folder.name}</span>
                  </motion.button>
                ))}
              </div>
            ) : null}

            {loading ? <FileSkeletonGrid view={view} /> : null}

            <motion.div layout className={cn(loading && "hidden", view === "grid" ? "grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "space-y-2")}>
              <AnimatePresence mode="popLayout">
                {files.map(file => (
                  <FileTile
                    key={file.id}
                    file={file}
                    grid={view === "grid"}
                    onPreview={() => setPreviewFile(file)}
                    onDownload={() => {
                      toast.info("Preparing download…");
                      window.location.href = `/api/download/${file.id}`;
                    }}
                    onShare={() => shareFile(file.id)}
                    onDelete={() => deleteFile(file.id)}
                  />
                ))}
              </AnimatePresence>
            </motion.div>

            {!loading && !files.length && !folders.length ? (
              <div className="rounded-2xl border p-12 text-center" style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
                <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl" style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.15)" }}>
                  <FileIcon className="h-8 w-8" style={{ color: "#00d4ff" }} />
                </div>
                <p className="font-semibold" style={{ color: "#e2e8f0" }}>No files yet</p>
                <p className="mt-1 text-sm" style={{ color: "#475569" }}>Upload something and TeleDrive will route it automatically.</p>
              </div>
            ) : null}
          </>
          )}
        </section>
      </motion.main>

      {/* Preview modal */}
      <AnimatePresence>
        {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
      </AnimatePresence>
    </div>
  );
}

function FileTile({ file, grid, onPreview, onDownload, onShare, onDelete }: { file: DriveFile; grid: boolean; onPreview: () => void; onDownload: () => void; onShare: () => void; onDelete: () => void }) {
  const Icon = file.mimeType.startsWith("image/") ? Image : file.mimeType.startsWith("video/") ? Video : FileIcon;
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const isImage = file.mimeType.startsWith("image/");
  const isVideo = file.mimeType.startsWith("video/");
  const preview = isImage ? `/api/preview/${file.id}` : isVideo ? `/api/stream/${file.id}` : "";
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      whileHover={{ y: grid ? -3 : 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={cn("drive-card rounded-xl border p-4 transition", !grid && "flex items-center gap-4")}
      style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)" }}
    >
      <div
        className={cn("relative grid overflow-hidden place-items-center rounded-lg", grid ? "mb-4 aspect-video" : "h-12 w-12 shrink-0")}
        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", cursor: "zoom-in" }}
        onClick={onPreview}
        title="Click to preview"
      >
        {(isImage || isVideo) && !mediaLoaded ? (
          <div className="absolute inset-0 animate-pulse" style={{ background: "linear-gradient(90deg, rgba(255,255,255,0.04), rgba(0,212,255,0.06), rgba(255,255,255,0.04))" }} />
        ) : null}
        {isImage ? (
          <img
            src={preview}
            alt={file.originalName}
            className={cn("h-full w-full rounded-lg object-cover transition duration-500", mediaLoaded ? "scale-100 opacity-100" : "scale-[1.02] opacity-0")}
            loading="lazy"
            decoding="async"
            onLoad={() => setMediaLoaded(true)}
            onError={() => setMediaLoaded(true)}
          />
        ) : isVideo ? (
          <video src={preview} className="h-full w-full rounded-lg object-cover" muted preload="metadata" onLoadedData={() => setMediaLoaded(true)} />
        ) : (
          <Icon className="h-8 w-8" style={{ color: "#00d4ff" }} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold" style={{ color: "#e2e8f0" }}>{file.originalName}</h3>
        <p className="mt-1 text-xs" style={{ color: "#475569" }}>{formatBytes(file.size)} · {file.storageMode}</p>
      </div>
      {/* Desktop list view & all grid views: show 3 buttons */}
      <div className={cn("flex gap-2", grid ? "mt-4" : "ml-auto hidden sm:flex")}>
        <button
          onClick={onDownload}
          className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
          style={{ borderColor: "rgba(255,255,255,0.1)", background: "transparent", color: "#94a3b8" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,212,255,0.5)"; (e.currentTarget as HTMLElement).style.color = "#00d4ff"; (e.currentTarget as HTMLElement).style.background = "rgba(0,212,255,0.08)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)"; (e.currentTarget as HTMLElement).style.color = "#94a3b8"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          aria-label="Download"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          onClick={onShare}
          className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
          style={{ borderColor: "rgba(255,255,255,0.1)", background: "transparent", color: "#94a3b8", cursor: "pointer" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,212,255,0.5)"; (e.currentTarget as HTMLElement).style.color = "#00d4ff"; (e.currentTarget as HTMLElement).style.background = "rgba(0,212,255,0.08)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)"; (e.currentTarget as HTMLElement).style.color = "#94a3b8"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          aria-label="Share"
        >
          <Link2 className="h-4 w-4" />
        </button>
        <button
          onClick={onDelete}
          className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
          style={{ borderColor: "rgba(255,255,255,0.1)", background: "transparent", color: "#f87171" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(239,68,68,0.5)"; (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          aria-label="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {/* Mobile list view only: collapse into ⋯ dropdown */}
      {!grid && (
        <div className="ml-auto flex sm:hidden">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
                style={{ borderColor: "rgba(255,255,255,0.1)", background: "transparent", color: "#94a3b8" }}
                aria-label="More actions"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-50 min-w-[150px] overflow-hidden rounded-xl p-1 shadow-2xl"
                style={{ border: "1px solid rgba(255,255,255,0.1)", background: "rgba(13,24,41,0.95)", backdropFilter: "blur(20px)" }}
              >
                <DropdownMenu.Item
                  onSelect={onDownload}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "#e2e8f0" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(0,212,255,0.1)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <Download className="h-4 w-4" style={{ color: "#00d4ff" }} /> Download
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onShare}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "#e2e8f0" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(0,212,255,0.1)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <Link2 className="h-4 w-4" style={{ color: "#00d4ff" }} /> Share
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onDelete}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "#f87171" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </motion.article>
  );
}

function FileSkeletonGrid({ view }: { view: "grid" | "list" }) {
  return (
    <div className={view === "grid" ? "grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "space-y-2"}>
      {Array.from({ length: view === "grid" ? 8 : 5 }).map((_, index) => (
        <div
          key={index}
          className={cn("rounded-xl border p-4", view === "list" && "flex items-center gap-4")}
          style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}
        >
          <div
            className={cn("animate-pulse rounded-lg", view === "grid" ? "mb-4 aspect-video" : "h-12 w-12 shrink-0")}
            style={{ background: "linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(0,212,255,0.06) 50%, rgba(255,255,255,0.04) 100%)", backgroundSize: "200% 100%", animation: "pulse 1.5s ease-in-out infinite" }}
          />
          <div className="space-y-2">
            <div className="h-4 w-40 animate-pulse rounded-md" style={{ background: "rgba(255,255,255,0.06)" }} />
            <div className="h-3 w-24 animate-pulse rounded-md" style={{ background: "rgba(255,255,255,0.04)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({ theme, setTheme, authStatus }: { theme: ThemeMode; setTheme: (theme: ThemeMode) => void; authStatus: "connected" | "pending" | "failed" }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="grid gap-4 lg:grid-cols-2"
    >
      <section className="rounded-xl border p-5" style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)" }}>
        <h2 className="font-semibold" style={{ color: "#e2e8f0" }}>Appearance</h2>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { value: "light" as ThemeMode, icon: Sun, label: "Light" },
            { value: "dark" as ThemeMode, icon: Moon, label: "Dark" },
            { value: "system" as ThemeMode, icon: Monitor, label: "System" }
          ].map(item => (
            <button
              key={item.value}
              onClick={() => setTheme(item.value)}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border text-sm transition active:scale-[0.96]"
              style={theme === item.value
                ? { borderColor: "#00d4ff", background: "rgba(0,212,255,0.12)", color: "#00d4ff", boxShadow: "0 0 14px rgba(0,212,255,0.2)" }
                : { borderColor: "rgba(255,255,255,0.08)", background: "transparent", color: "#94a3b8" }
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-xl border p-5" style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)" }}>
        <h2 className="font-semibold" style={{ color: "#e2e8f0" }}>Telegram Connection</h2>
        <div className="mt-4 flex items-center gap-2 text-sm">
          {authStatus === "connected"
            ? <CheckCircle2 className="h-5 w-5" style={{ color: "#34d399" }} />
            : <AlertCircle className="h-5 w-5" style={{ color: "#f87171" }} />}
          <span style={{ color: "#94a3b8" }}>{authStatus === "connected" ? "Connected with Telegram login" : "Session needs attention"}</span>
        </div>
        <p className="mt-3 text-sm" style={{ color: "#475569" }}>
          If Telegram login stops working, set the production domain in BotFather and sign in again. Large personal-storage uploads also require a valid GramJS session.
        </p>
        <button
          onClick={() => { window.location.href = "/"; }}
          className="btn-ripple mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border px-4 text-sm transition active:scale-[0.96]"
          style={{ borderColor: "rgba(0,212,255,0.3)", background: "rgba(0,212,255,0.06)", color: "#00d4ff" }}
        >
          <RotateCw className="h-4 w-4" />
          Reconnect Telegram
        </button>
      </section>
    </motion.div>
  );
}

function CloudIcon() {
  return <Upload className="h-5 w-5" />;
}

function PreviewModal({ file, onClose }: { file: DriveFile; onClose: () => void }) {
  const isImage = file.mimeType.startsWith("image/") && !file.mimeType.includes("heic") && !file.mimeType.includes("heif");
  const isVideo = file.mimeType.startsWith("video/");
  const previewUrl = isImage ? `/api/preview/${file.id}` : isVideo ? `/api/stream/${file.id}` : "";
  const Icon = isImage ? Image : isVideo ? Video : FileIcon;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 40 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 40 }}
        transition={{ type: "spring", damping: 22, stiffness: 320 }}
        className="relative w-full sm:max-w-3xl rounded-t-3xl sm:rounded-2xl overflow-hidden"
        style={{ border: "1px solid rgba(0,212,255,0.18)", background: "rgba(7,13,26,0.97)", maxHeight: "92vh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle bar for mobile */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full" style={{ background: "rgba(255,255,255,0.2)" }} />
        </div>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-sm" style={{ color: "#e2e8f0" }}>{file.originalName}</h3>
            <p className="text-xs" style={{ color: "#475569" }}>{formatBytes(file.size)} · {file.storageMode} · {file.mimeType}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { window.location.href = `/api/download/${file.id}`; }}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition"
              style={{ border: "1px solid rgba(0,212,255,0.3)", background: "rgba(0,212,255,0.08)", color: "#00d4ff" }}
            >
              <Download className="h-3.5 w-3.5" /> Download
            </button>
            <button
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-xl transition"
              style={{ border: "1px solid rgba(255,255,255,0.1)", color: "#64748b" }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {/* Content */}
        <div className="flex items-center justify-center overflow-auto" style={{ minHeight: 220, maxHeight: "74vh", padding: "1rem" }}>
          {isImage ? (
            <motion.img
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              src={previewUrl}
              alt={file.originalName}
              className="rounded-xl object-contain"
              style={{ maxWidth: "100%", maxHeight: "70vh" }}
            />
          ) : isVideo ? (
            <video
              src={previewUrl}
              controls
              autoPlay
              className="rounded-xl"
              style={{ maxWidth: "100%", maxHeight: "70vh" }}
            />
          ) : (
            <div className="text-center py-8">
              <div className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-2xl" style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.15)" }}>
                <Icon className="h-10 w-10" style={{ color: "#00d4ff" }} />
              </div>
              <p className="font-semibold" style={{ color: "#94a3b8" }}>No preview available</p>
              {(file.mimeType.includes("heic") || file.mimeType.includes("heif")) && (
                <p className="mt-1 text-sm" style={{ color: "#475569" }}>HEIC/HEIF isn't supported by browsers. Download to view.</p>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
