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
  const [uploadProgress, setUploadProgress] = useState<{ name: string; percent: number } | null>(null);
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
      const maxTelegramSize = 2 * 1024 * 1024 * 1024;
      const tooLarge = acceptedFiles.find(file => file.size > maxTelegramSize);
      if (tooLarge) {
        toast.error(`${tooLarge.name} is larger than Telegram's 2GB limit.`);
        return;
      }
      setUploading(true);
      try {
        for (const file of acceptedFiles) {
          if (file.size > 50 * 1024 * 1024) {
            toast.info("Large files use personal Telegram storage and may take longer on Vercel.");
          }
          const form = new FormData();
          form.append("file", file);
          if (folderId) form.append("folderId", folderId);
          setUploadProgress({ name: file.name, percent: 0 });
          const { data } = await uploadFile<{ routing: { storageMode: "BOT" | "PERSONAL" } }>("/api/upload", form, percent => {
            setUploadProgress({ name: file.name, percent });
          });
          toast.success(`${file.name} uploaded to ${data.routing.storageMode === "BOT" ? "bot storage" : "personal storage"}`);
        }
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Upload failed");
      } finally {
        setUploading(false);
        setUploadProgress(null);
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
    if (!confirm("Move this file to trash?")) return;
    try {
      await apiFetch(`/api/files/${fileId}`, { method: "DELETE" });
      toast.success("File moved to trash");
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
    <div {...getRootProps()} className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] transition-colors duration-300">
      <input {...getInputProps()} />
      {sidebarOpen ? <button className="fixed inset-0 z-30 bg-black/30 lg:hidden" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} /> : null}
      <motion.aside
        initial={{ x: -24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[86vw] max-w-72 border-r border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-5 transition md:w-72",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xl font-semibold">
            <div className="grid h-10 w-10 place-items-center rounded-md bg-sky-600 text-white">
              <CloudIcon />
            </div>
            TeleDrive
          </div>
          <button className="lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <Button className="mt-8 min-h-11 w-full active:scale-[0.96]" onClick={open} disabled={uploading}>
          <Upload className="h-4 w-4" />
          {uploading ? "Uploading..." : "Upload"}
        </Button>
        {uploadProgress ? (
          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate">{uploadProgress.name}</span>
              <span>{uploadProgress.percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <motion.div className="h-full bg-sky-600" initial={{ width: 0 }} animate={{ width: `${uploadProgress.percent}%` }} />
            </div>
          </div>
        ) : null}
        <nav className="mt-7 space-y-1">
          {navItems.map(({ icon: Icon, label, view: itemView }) => (
            <button
              key={label}
              onClick={() => selectView(itemView)}
              className={cn(
                "relative flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500 dark:text-slate-300 dark:hover:bg-slate-800",
                appView === itemView && "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-200"
              )}
            >
              {appView === itemView ? <motion.span layoutId="nav-active" className="absolute left-0 h-6 w-1 rounded-r-full bg-sky-600" /> : null}
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="absolute bottom-5 left-4 right-4 rounded-lg border border-[var(--border)] p-4">
          <p className="text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-slate-500">{user.username ? `@${user.username}` : "Telegram account"}</p>
          <div className="mt-3 flex items-center gap-2 text-xs">
            {authStatus === "connected" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : authStatus === "failed" ? <AlertCircle className="h-4 w-4 text-red-500" /> : <RotateCw className="h-4 w-4 animate-spin text-sky-500" />}
            <span>{authStatus === "connected" ? "Connected" : authStatus === "failed" ? "Reconnect needed" : "Checking..."}</span>
          </div>
          <p className="mt-4 text-xs text-slate-500">Visible folder size</p>
          <p className="text-sm font-semibold">{formatBytes(storageUsed)}</p>
        </div>
      </motion.aside>

      <motion.main className="lg:pl-72" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
        <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg-primary)]/85 backdrop-blur">
          <div className="flex min-h-14 items-center gap-2 px-3 md:min-h-16 md:gap-3 md:px-8">
            <button className="grid h-11 w-11 place-items-center rounded-md lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Menu className="h-5 w-5" />
            </button>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search in this folder"
                className="h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] pl-10 pr-3 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
              />
            </div>
            <button
              onClick={() => setTheme(current => (current === "system" ? "light" : current === "light" ? "dark" : "system"))}
              className="grid h-11 w-11 place-items-center rounded-md border border-[var(--border)] active:scale-[0.96]"
              aria-label="Toggle dark mode"
            >
              {theme === "system" ? <Monitor className="h-4 w-4" /> : theme === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button onClick={logout} className="grid h-11 w-11 place-items-center rounded-md border border-[var(--border)] active:scale-[0.96]" aria-label="Logout">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <section className="px-4 py-6 md:px-8">
          <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                <button onClick={goHome} className="hover:text-sky-600">My Files</button>
                {folderTrail.map(folder => (
                  <span key={folder.id} className="flex items-center gap-2">
                    <span>/</span>
                    <span className="text-slate-800 dark:text-slate-200">{folder.name}</span>
                  </span>
                ))}
              </div>
              <h1 className="mt-2 text-xl font-semibold md:text-2xl">{appView === "settings" ? "Settings" : appView === "trash" ? "Trash" : appView === "favorites" ? "Favorites" : appView === "shared" ? "Shared" : "Personal cloud storage"}</h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-11 bg-white text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50 active:scale-[0.96] dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-800" onClick={createFolder} disabled={appView === "settings" || appView === "trash" || appView === "shared"}>
                <Plus className="h-4 w-4" />
                Folder
              </Button>
              <button onClick={() => setView("grid")} className={cn("grid h-11 w-11 place-items-center rounded-md border active:scale-[0.96]", view === "grid" && "bg-slate-900 text-white dark:bg-white dark:text-slate-900")}>
                <Grid2X2 className="h-4 w-4" />
              </button>
              <button onClick={() => setView("list")} className={cn("grid h-11 w-11 place-items-center rounded-md border active:scale-[0.96]", view === "list" && "bg-slate-900 text-white dark:bg-white dark:text-slate-900")}>
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {appView === "settings" ? (
            <SettingsPanel theme={theme} setTheme={setTheme} authStatus={authStatus} />
          ) : (
          <>
            <div
            className={cn(
              "mb-6 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center transition dark:border-slate-700 dark:bg-slate-900",
              isDragActive && "scale-[1.01] border-sky-500 bg-sky-50 shadow-lg shadow-sky-100 dark:bg-sky-950 dark:shadow-none"
            )}
          >
            <Upload className="mx-auto mb-3 h-8 w-8 text-sky-600" />
            <p className="font-medium">Drop files or folders here</p>
            <p className="mt-1 text-sm text-slate-500">Automatic routing sends videos and large files to personal Telegram storage.</p>
          </div>

          {folders.length > 0 ? (
            <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {folders.map(folder => (
                <motion.button
                  key={folder.id}
                  layout
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => enterFolder(folder)}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-sky-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
                >
                  <Folder className="h-6 w-6 text-amber-500" />
                  <span className="truncate font-medium">{folder.name}</span>
                </motion.button>
              ))}
            </div>
          ) : null}

          {loading ? <FileSkeletonGrid view={view} /> : null}

          <motion.div layout className={cn(loading && "hidden", view === "grid" ? "grid gap-4 sm:grid-cols-2 xl:grid-cols-4" : "space-y-2")}>
            <AnimatePresence mode="popLayout">
              {files.map(file => (
                <FileTile
                  key={file.id}
                  file={file}
                  grid={view === "grid"}
                  onDownload={() => {
                    toast.info("Preparing download...");
                    window.location.href = `/api/download/${file.id}`;
                  }}
                  onShare={() => shareFile(file.id)}
                  onDelete={() => deleteFile(file.id)}
                />
              ))}
            </AnimatePresence>
          </motion.div>
          {!loading && !files.length && !folders.length ? (
            <div className="rounded-lg border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
              <FileIcon className="mx-auto mb-3 h-10 w-10 text-slate-400" />
              <p className="font-medium">No files yet</p>
              <p className="mt-1 text-sm text-slate-500">Upload something and TeleDrive will route it automatically.</p>
            </div>
          ) : null}
          </>
          )}
        </section>
      </motion.main>
    </div>
  );
}

function FileTile({ file, grid, onDownload, onShare, onDelete }: { file: DriveFile; grid: boolean; onDownload: () => void; onShare: () => void; onDelete: () => void }) {
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
      className={cn("rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900", !grid && "flex items-center gap-4")}
    >
      <div className={cn("relative grid overflow-hidden place-items-center rounded-md bg-slate-100 dark:bg-slate-800", grid ? "mb-4 aspect-video" : "h-12 w-12 shrink-0")}>
        {(isImage || isVideo) && !mediaLoaded ? <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-slate-100 via-slate-200 to-slate-100 dark:from-slate-800 dark:via-slate-700 dark:to-slate-800" /> : null}
        {isImage ? (
          <img
            src={preview}
            alt={file.originalName}
            className={cn("h-full w-full rounded-md object-cover transition duration-500", mediaLoaded ? "scale-100 opacity-100" : "scale-[1.02] opacity-0")}
            loading="lazy"
            decoding="async"
            onLoad={() => setMediaLoaded(true)}
            onError={() => setMediaLoaded(true)}
          />
        ) : isVideo ? (
          <video src={preview} className="h-full w-full rounded-md object-cover" muted preload="metadata" onLoadedData={() => setMediaLoaded(true)} />
        ) : (
          <Icon className="h-8 w-8 text-sky-600" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold">{file.originalName}</h3>
        <p className="mt-1 text-xs text-slate-500">{formatBytes(file.size)} - {file.storageMode}</p>
      </div>
      <div className={cn("flex gap-2", grid ? "mt-4" : "ml-auto")}>
        <button onClick={onDownload} className="grid h-11 w-11 place-items-center rounded-md border border-slate-200 hover:bg-slate-50 active:scale-[0.96] dark:border-slate-800 dark:hover:bg-slate-800" aria-label="Download">
          <Download className="h-4 w-4" />
        </button>
        <button onClick={onShare} className="grid h-11 w-11 place-items-center rounded-md border border-slate-200 hover:bg-slate-50 active:scale-[0.96] dark:border-slate-800 dark:hover:bg-slate-800" aria-label="Share">
          <Link2 className="h-4 w-4" />
        </button>
        <button onClick={onDelete} className="grid h-11 w-11 place-items-center rounded-md border border-slate-200 text-red-600 hover:bg-red-50 active:scale-[0.96] dark:border-slate-800 dark:hover:bg-red-950" aria-label="Delete">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </motion.article>
  );
}

function FileSkeletonGrid({ view }: { view: "grid" | "list" }) {
  return (
    <div className={view === "grid" ? "grid gap-4 sm:grid-cols-2 xl:grid-cols-4" : "space-y-2"}>
      {Array.from({ length: view === "grid" ? 8 : 5 }).map((_, index) => (
        <div key={index} className={cn("rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900", view === "list" && "flex items-center gap-4")}>
          <div className={cn("animate-pulse rounded-md bg-slate-100 dark:bg-slate-800", view === "grid" ? "mb-4 aspect-video" : "h-12 w-12 shrink-0")} />
          <div className="space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
            <div className="h-3 w-24 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
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
      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
        <h2 className="font-semibold">Appearance</h2>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { value: "light" as ThemeMode, icon: Sun, label: "Light" },
            { value: "dark" as ThemeMode, icon: Moon, label: "Dark" },
            { value: "system" as ThemeMode, icon: Monitor, label: "System" }
          ].map(item => (
            <button
              key={item.value}
              onClick={() => setTheme(item.value)}
              className={cn(
                "flex min-h-11 items-center justify-center gap-2 rounded-md border border-[var(--border)] text-sm transition hover:border-sky-400 active:scale-[0.96]",
                theme === item.value && "border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-200"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
        <h2 className="font-semibold">Telegram Connection</h2>
        <div className="mt-4 flex items-center gap-2 text-sm">
          {authStatus === "connected" ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <AlertCircle className="h-5 w-5 text-red-500" />}
          <span>{authStatus === "connected" ? "Connected with Telegram login" : "Session needs attention"}</span>
        </div>
        <p className="mt-3 text-sm text-slate-500">
          If Telegram login stops working, set the production domain in BotFather and sign in again. Large personal-storage uploads also require a valid GramJS session.
        </p>
        <button
          onClick={() => {
            window.location.href = "/";
          }}
          className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--border)] px-4 text-sm hover:bg-slate-50 active:scale-[0.96] dark:hover:bg-slate-800"
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
