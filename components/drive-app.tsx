"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  Grid2X2,
  Home,
  Image,
  Info,
  Link2,
  List,
  LogOut,
  Mail,
  Maximize,
  Menu,
  Minimize,
  MoreVertical,
  Monitor,
  Moon,
  Pencil,
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

type AppView = "home" | "files" | "shared" | "recent" | "favorites" | "trash" | "settings" | "about";
type ThemeMode = "light" | "dark" | "system";

export default function DriveApp({ user }: { user: { name: string; username?: string | null; avatar?: string | null } }) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("folder") : null
  );
  const [folderTrail, setFolderTrail] = useState<DriveFolder[]>([]);
  const [navDirection, setNavDirection] = useState(0);
  const trailsByFolder = useRef<Map<string | null, DriveFolder[]>>(new Map([[null, []]]));

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [appView, setAppView] = useState<AppView>("files");
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ id: string; name: string; size: number; percent: number; status: "pending" | "uploading" | "done" | "error"; error?: string }[]>([]);
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const [folderModal, setFolderModal] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; body: string; danger?: boolean; onConfirm: () => void } | null>(null);
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

  useEffect(() => {
    if (!uploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Upload in progress — leaving will cancel it.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [uploading]);

  const uploadFiles = useCallback(
    async (acceptedFiles: File[]) => {
      const maxSize = 2 * 1024 * 1024 * 1024;
      const tooLarge = acceptedFiles.find(f => f.size > maxSize);
      if (tooLarge) {
        toast.error(`"${tooLarge.name}" exceeds Telegram's 2 GB file limit.`);
        return;
      }
      const items = acceptedFiles.map(f => ({ id: Math.random().toString(36).slice(2), name: f.name, size: f.size, percent: 0, status: "pending" as const }));
      setUploadQueue(items);
      setUploading(true);
      let anyError = false;
      for (let i = 0; i < acceptedFiles.length; i++) {
        const file = acceptedFiles[i];
        const itemId = items[i].id;
        try {
          setUploadQueue(q => q.map(it => it.id === itemId ? { ...it, status: "uploading" } : it));
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

  async function submitFolderModal(name: string) {
    if (!folderModal) return;
    try {
      if (folderModal.mode === "create") {
        await apiFetch("/api/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, parentId: folderId }) });
        toast.success("Folder created");
      } else {
        await apiFetch(`/api/folders/${folderModal.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        toast.success("Folder renamed");
      }
      setFolderModal(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save folder.");
    }
  }

  function deleteFolder(id: string) {
    setConfirmModal({
      title: "Delete Folder",
      body: "This folder and all files inside will be moved to trash. Continue?",
      danger: true,
      onConfirm: async () => {
        try {
          await apiFetch(`/api/folders/${id}`, { method: "DELETE" });
          toast.success("Folder and its files moved to trash");
          refresh();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not delete folder.");
        }
      }
    });
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

  function deleteFile(fileId: string) {
    const inTrash = appView === "trash";
    setConfirmModal({
      title: inTrash ? "Permanently Delete" : "Move to Trash",
      body: inTrash ? "This file will be permanently deleted and cannot be recovered." : "This file will be moved to trash. You can restore it later.",
      danger: true,
      onConfirm: async () => {
        try {
          await apiFetch(`/api/files/${fileId}`, { method: "DELETE" });
          toast.success(inTrash ? "File permanently deleted" : "File moved to trash");
          refresh();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not delete file.");
        }
      }
    });
  }

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/";
    }
  }

  // Browser back/forward navigation
  useEffect(() => {
    const handlePop = () => {
      const newFolderId = new URLSearchParams(window.location.search).get("folder");
      setFolderId(newFolderId);
      setFolderTrail(trailsByFolder.current.get(newFolderId) ?? []);
      setNavDirection(0);
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  async function toggleFavorite(fileId: string) {
    const file = files.find(f => f.id === fileId);
    if (!file) return;
    const newValue = !file.isFavorite;
    setFiles(fs => fs.map(f => f.id === fileId ? { ...f, isFavorite: newValue } : f));
    try {
      await apiFetch(`/api/files/${fileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isFavorite: newValue })
      });
    } catch {
      setFiles(fs => fs.map(f => f.id === fileId ? { ...f, isFavorite: !newValue } : f));
      toast.error("Could not update favorite.");
    }
  }

  async function restoreFile(fileId: string) {
    try {
      await apiFetch(`/api/files/${fileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restore: true })
      });
      toast.success("File restored");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not restore file.");
    }
  }

  async function shareFolder(folderId: string) {
    try {
      const data = await apiFetch<{ shareUrl: string }>("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId })
      });
      await navigator.clipboard.writeText(`${window.location.origin}${data.shareUrl}`);
      toast.success("Folder share link copied to clipboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Share failed.");
    }
  }


  function enterFolder(folder: DriveFolder) {
    const newTrail = [...folderTrail, folder];
    trailsByFolder.current.set(folder.id, newTrail);
    setNavDirection(1);
    setFolderTrail(newTrail);
    setFolderId(folder.id);
    window.history.pushState(null, "", `?folder=${folder.id}`);
  }

  function goHome() {
    setNavDirection(-1);
    setFolderTrail([]);
    setFolderId(null);
    setAppView("files");
    window.history.pushState(null, "", "?");
  }

  function navigateBackInTrail(folder: DriveFolder) {
    const idx = folderTrail.findIndex(f => f.id === folder.id);
    const newTrail = idx >= 0 ? folderTrail.slice(0, idx + 1) : [];
    setNavDirection(-1);
    setFolderTrail(newTrail);
    setFolderId(folder.id);
    window.history.pushState(null, "", `?folder=${folder.id}`);
  }


  const navItems = [
    { icon: Home, label: "Home", view: "home" as AppView },
    { icon: Folder, label: "My Files", view: "files" as AppView },
    { icon: Link2, label: "Shared", view: "shared" as AppView },
    { icon: Star, label: "Favorites", view: "favorites" as AppView },
    { icon: Trash2, label: "Trash", view: "trash" as AppView },
    { icon: Settings, label: "Settings", view: "settings" as AppView },
    { icon: Info, label: "About", view: "about" as AppView }
  ];

  function selectView(nextView: AppView) {
    setNavDirection(0);
    setAppView(nextView);
    setSidebarOpen(false);
    if (nextView !== "settings") {
      setFolderId(null);
      setFolderTrail([]);
      window.history.pushState(null, "", "?");
    }
    if (nextView === "shared") toast.info("Shared file management is coming next. Public links already work from file cards.");
  }


  return (
    <div
      {...getRootProps()}
      className="drive-bg min-h-screen text-[var(--text-primary)]"
    >
      <input {...getInputProps()} />
      {sidebarOpen ? <button className="fixed inset-0 z-30 bg-black/50 lg:hidden" style={{ backdropFilter: "blur(2px)" }} aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} /> : null}

      {/* ── Sidebar ── */}
      <motion.aside
        initial={{ x: -28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 340, damping: 32 }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[272px] flex-col border-r px-5 py-6 transition-transform md:w-[272px]",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
        style={{
          borderColor: "var(--cyan-border)",
          background: "color-mix(in srgb, var(--bg-0) 94%, transparent)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
          boxShadow: "inset -1px 0 0 var(--border-dim), 4px 0 24px rgba(0,0,0,0.2)"
        }}
      >
        {/* Decorative top-left glow */}
        <div className="pointer-events-none absolute -top-20 -left-12 h-48 w-48 rounded-full opacity-30"
          style={{ background: "radial-gradient(circle, rgba(0,229,255,0.4) 0%, transparent 70%)", filter: "blur(40px)" }} />

        {/* Logo */}
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative grid h-9 w-9 place-items-center rounded-xl shrink-0"
              style={{ background: "linear-gradient(135deg,#00e5ff,#8b5cf6)", boxShadow: "0 0 20px rgba(0,229,255,0.35), 0 0 40px rgba(139,92,246,0.15)" }}>
              <CloudIcon />
            </div>
            <div>
              <p className="text-[15px] font-[800] leading-none tracking-tight gradient-text">TeleDrive</p>
              <p className="mt-0.5 text-[9px] tracking-[0.2em] uppercase" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono), monospace" }}>Personal Cloud</p>
            </div>
          </div>
          <button className="lg:hidden grid h-8 w-8 place-items-center rounded-lg" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" style={{ color: "var(--text-secondary)", border: "1px solid var(--border-dim)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Upload button */}
        <button
          onClick={open}
          disabled={uploading}
          className="btn-ripple relative mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl font-[700] text-sm tracking-wide transition active:scale-[0.97] disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, #00e5ff 0%, #8b5cf6 100%)",
            color: "#fff",
            boxShadow: "0 0 22px rgba(0,229,255,0.28), 0 0 44px rgba(139,92,246,0.12)",
            cursor: uploading ? "not-allowed" : "pointer"
          }}
        >
          <Upload className="h-4 w-4" />
          {uploading ? "Uploading…" : "Upload Files"}
        </button>

        <AnimatePresence>
          {uploadQueue.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 overflow-hidden rounded-xl border"
              style={{ borderColor: "var(--cyan-border)", background: "rgba(0,229,255,0.04)" }}
            >
              <div className="max-h-52 overflow-y-auto p-2 space-y-1.5">
                {uploadQueue.map(item => (
                  <div key={item.id} className="rounded-lg p-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
                    <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
                      <span className="truncate font-medium" style={{ color: "#e2e8f0", maxWidth: "75%" }}>{item.name}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {item.status === "pending" && <span style={{ color: "#475569" }}>Waiting</span>}
                        {item.status === "uploading" && <span style={{ color: "var(--cyan)", fontFamily: "var(--font-mono),monospace", fontSize: "10px" }}>{item.percent}%</span>}
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
                        style={{ background: item.status === "error" ? "var(--danger)" : item.status === "done" ? "var(--emerald)" : item.status === "pending" ? "rgba(255,255,255,0.08)" : "linear-gradient(90deg,var(--cyan),var(--violet))" }}
                        initial={{ width: 0 }}
                        animate={{ width: item.status === "pending" ? "100%" : `${item.status === "done" ? 100 : item.percent}%` }}
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
        <nav className="mt-5 flex-1 space-y-0.5 overflow-y-auto pb-4">
          {navItems.map(({ icon: Icon, label, view: itemView }) => {
            const active = appView === itemView;
            return (
              <button
                key={label}
                onClick={() => selectView(itemView)}
                className="nav-item-drive relative flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-[500] transition focus:outline-none"
                style={{
                  color: active ? "#fff" : "var(--text-secondary)",
                  background: active ? "linear-gradient(135deg, rgba(0,229,255,0.12), rgba(139,92,246,0.1))" : "transparent",
                  border: active ? "1px solid rgba(0,229,255,0.18)" : "1px solid transparent",
                  boxShadow: active ? "inset 0 1px 0 rgba(0,229,255,0.1)" : "none"
                }}
              >
                {active && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full"
                    style={{ background: "linear-gradient(180deg,#00e5ff,#8b5cf6)", boxShadow: "0 0 12px rgba(0,229,255,0.6)" }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <Icon className="h-4 w-4 shrink-0" style={{ color: active ? "var(--cyan)" : undefined }} />
                {label}
              </button>
            );
          })}
        </nav>

        {/* User card — mt-auto keeps it at bottom without absolute overlap */}
        <div className="mt-auto rounded-2xl p-4" style={{ border: "1px solid rgba(0,229,255,0.1)", background: "linear-gradient(135deg, rgba(0,229,255,0.04), rgba(139,92,246,0.04))" }}>
          <div className="flex items-center gap-3 mb-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-[700]"
              style={{ background: "linear-gradient(135deg,#00e5ff,#8b5cf6)", color: "#fff" }}>
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-[600] truncate" style={{ color: "var(--text-primary)" }}>{user.name}</p>
              <p className="truncate text-[11px]" style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono),monospace" }}>{user.username ? `@${user.username}` : "Telegram"}</p>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {authStatus === "connected" ? <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--emerald)" }} /> : authStatus === "failed" ? <AlertCircle className="h-3.5 w-3.5" style={{ color: "var(--danger)" }} /> : <RotateCw className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--cyan)" }} />}
              <span>{authStatus === "connected" ? "Connected" : authStatus === "failed" ? "Reconnect" : "Checking…"}</span>
            </div>
            <span className="tag-cyan">{formatBytes(storageUsed)}</span>
          </div>
        </div>
      </motion.aside>

      {/* ── Main ── */}
      <motion.main className="lg:pl-[272px] min-h-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
        {/* Header */}
        <header className="sticky top-0 z-30" style={{ background: "color-mix(in srgb, var(--bg-0) 92%, transparent)", backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)", borderBottom: "1px solid var(--border-dim)", boxShadow: "0 1px 0 rgba(0,229,255,0.05)" }}>
          <div className="flex h-14 items-center gap-2 px-3 md:h-[58px] md:gap-3 md:px-5">
            {/* Hamburger — mobile only */}
            <button className="grid h-9 w-9 shrink-0 place-items-center rounded-xl lg:hidden" style={{ border: "1px solid var(--border-med)" }} onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Menu className="h-4 w-4" style={{ color: "var(--text-secondary)" }} />
            </button>

            {/* Brand logo — visible on mobile (lg: hidden because sidebar shows it) */}
            <div className="flex items-center gap-2 shrink-0 lg:hidden">
              <div className="grid h-8 w-8 place-items-center rounded-xl shrink-0"
                style={{ background: "linear-gradient(135deg,#00e5ff,#8b5cf6)", boxShadow: "0 0 14px rgba(0,229,255,0.4)" }}>
                <CloudIcon size={16} />
              </div>
              <span className="text-[14px] font-[800] gradient-text tracking-tight hidden sm:block">TeleDrive</span>
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text-muted)" }} />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search files…"
                style={{
                  cursor: "text",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid var(--border-dim)",
                  color: "var(--text-primary)",
                  borderRadius: 12,
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.8125rem"
                }}
                className="h-9 w-full pl-9 pr-3 outline-none transition focus:border-[rgba(0,229,255,0.4)] focus:ring-2 focus:ring-[rgba(0,229,255,0.1)]"
              />
            </div>

            {/* Upload badge — show active upload progress */}
            <AnimatePresence>
              {uploading && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="hidden sm:flex items-center gap-2 shrink-0 rounded-xl px-3 py-1.5"
                  style={{ border: "1px solid var(--cyan-border)", background: "rgba(0,229,255,0.06)" }}
                >
                  <div className="h-1.5 w-20 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
                    <motion.div
                      className="h-full rounded-full upload-progress-bar"
                      animate={{ width: `${uploadQueue.reduce((a, b) => a + b.percent, 0) / Math.max(uploadQueue.length, 1)}%` }}
                      transition={{ ease: "easeOut", duration: 0.3 }}
                    />
                  </div>
                  <span className="text-[11px] font-[700] tabular-nums" style={{ color: "var(--cyan)", fontFamily: "var(--font-mono),monospace" }}>
                    {Math.round(uploadQueue.reduce((a, b) => a + b.percent, 0) / Math.max(uploadQueue.length, 1))}%
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setTheme(current => (current === "system" ? "dark" : current === "dark" ? "light" : "system"))}
                className="grid h-9 w-9 place-items-center rounded-xl transition active:scale-[0.94]"
                style={{ border: "1px solid var(--border-dim)", color: "var(--text-secondary)" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--cyan)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--cyan-border)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-dim)"; }}
                title={`Theme: ${theme} — click to cycle`}
                aria-label="Toggle theme"
              >
                {theme === "system" ? <Monitor className="h-4 w-4" /> : theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </button>
              <button
                onClick={logout}
                className="grid h-9 w-9 place-items-center rounded-xl transition active:scale-[0.94]"
                style={{ border: "1px solid var(--border-dim)", color: "var(--text-secondary)" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--danger)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,77,109,0.35)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-dim)"; }}
                aria-label="Logout"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
          {/* Thin upload progress line */}
          <AnimatePresence>
            {uploading && (
              <motion.div
                initial={{ scaleX: 0, opacity: 0 }}
                animate={{ scaleX: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                style={{ transformOrigin: "left", height: 2 }}
                className="upload-progress-bar"
              />
            )}
          </AnimatePresence>
        </header>

        <section className="px-4 py-5 md:px-6 md:py-6 max-w-7xl mx-auto">
          <div className="mb-6 flex items-start justify-between gap-3">
            <div className="min-w-0">
              {/* Breadcrumb */}
              <div className="flex flex-wrap items-center gap-1 text-[11px] mb-1.5" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono),monospace", letterSpacing: "0.03em" }}>
                <button onClick={goHome} className="transition hover:text-[var(--cyan)]">~/</button>
                {folderTrail.map(folder => (
                  <span key={folder.id} className="flex items-center gap-1">
                    <span style={{ color: "var(--text-muted)" }}>›</span>
                    <button onClick={() => navigateBackInTrail(folder)} className="transition hover:text-[var(--cyan)]" style={{ color: "var(--text-secondary)" }}>{folder.name}</button>
                  </span>
                ))}
              </div>
              <h1 className="text-xl font-[800] md:text-[26px] leading-tight truncate tracking-tight gradient-text">
                {appView === "settings" ? "Settings" : appView === "trash" ? "Trash" : appView === "favorites" ? "Favorites" : appView === "shared" ? "Shared" : appView === "about" ? "About & Contact" : folderTrail.length > 0 ? folderTrail[folderTrail.length - 1].name : "My Files"}
              </h1>
            </div>
            <div className="flex items-center gap-2 shrink-0 pt-1">
              <button
                onClick={() => setFolderModal({ mode: "create", value: "" })}
                disabled={appView === "settings" || appView === "trash" || appView === "shared" || appView === "about"}
                className="btn-ripple flex h-9 items-center gap-1.5 rounded-xl px-3 text-[12px] font-[600] tracking-wide transition active:scale-[0.96] disabled:opacity-30"
                style={{ border: "1px solid var(--cyan-border)", color: "var(--cyan)", background: "var(--cyan-dim)" }}
              >
                <Plus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">New Folder</span>
              </button>
              <div className="flex items-center rounded-xl overflow-hidden" style={{ border: "1px solid var(--border-med)" }}>
                <button
                  onClick={() => setView("grid")}
                  className="grid h-9 w-9 place-items-center transition active:scale-[0.9]"
                  style={{ background: view === "grid" ? "rgba(0,229,255,0.12)" : "transparent", color: view === "grid" ? "var(--cyan)" : "var(--text-secondary)", borderRight: "1px solid var(--border-dim)" }}
                  aria-label="Grid view"
                >
                  <Grid2X2 className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setView("list")}
                  className="grid h-9 w-9 place-items-center transition active:scale-[0.9]"
                  style={{ background: view === "list" ? "rgba(0,229,255,0.12)" : "transparent", color: view === "list" ? "var(--cyan)" : "var(--text-secondary)" }}
                  aria-label="List view"
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <AnimatePresence mode="wait" custom={navDirection}>
          {appView === "settings" ? (
            <motion.div key="settings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
              <SettingsPanel theme={theme} setTheme={setTheme} authStatus={authStatus} />
            </motion.div>
          ) : appView === "about" ? (
            <motion.div key="about" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
              <AboutPanel />
            </motion.div>
          ) : (
          <motion.div
            key={`${appView}-${folderId ?? "root"}`}
            custom={navDirection}
            variants={{
              initial: (dir: number) => ({ opacity: 0, x: dir !== 0 ? dir * 48 : 0, y: dir === 0 ? 12 : 0 }),
              animate: { opacity: 1, x: 0, y: 0 },
              exit: (dir: number) => ({ opacity: 0, x: dir !== 0 ? dir * -36 : 0, y: dir === 0 ? -8 : 0 })
            }}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            {/* Drop zone */}
            <motion.div
              animate={{ scale: isDragActive ? 1.012 : 1, borderColor: isDragActive ? "var(--cyan)" : "rgba(0,229,255,0.18)" }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
              className={cn("mb-6 rounded-2xl border border-dashed", isDragActive && "dropzone-active")}
              style={{
                background: isDragActive ? "rgba(0,229,255,0.05)" : "rgba(0,229,255,0.015)",
                cursor: "crosshair",
                padding: "clamp(1.25rem,5vw,2.25rem)",
                textAlign: "center"
              }}
            >
              <motion.div
                animate={{ scale: isDragActive ? 1.15 : 1, rotate: isDragActive ? -8 : 0 }}
                transition={{ type: "spring", stiffness: 360, damping: 20 }}
                className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-2xl"
                style={{ background: isDragActive ? "rgba(0,229,255,0.2)" : "rgba(0,229,255,0.08)", border: "1px solid var(--cyan-border)" }}>
                <Upload className="h-5 w-5" style={{ color: "var(--cyan)" }} />
              </motion.div>
              <p className="font-[700] text-sm md:text-[15px]" style={{ color: "var(--text-primary)" }}>
                {isDragActive ? "Release to upload" : "Drop files or folders here"}
              </p>
              <p className="mt-1 text-xs md:text-sm" style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono),monospace" }}>
                Auto-routes · BOT ≤ 2 GB · MTProto ≤ 4 GB
              </p>
            </motion.div>

            {/* Folders */}
            {folders.length > 0 ? (
              <div className="mb-8 grid gap-3 grid-cols-2 sm:grid-cols-2 xl:grid-cols-4">
                {folders.map(folder => (
                  <motion.div
                    key={folder.id}
                    layout
                    whileHover={{ y: -3, scale: 1.015 }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: "spring", stiffness: 400, damping: 28 }}
                    className="folder-card grad-border relative flex items-center gap-3 rounded-xl border p-3.5 text-left transition"
                    style={{ borderColor: "rgba(139,92,246,0.15)", background: "rgba(139,92,246,0.04)", cursor: "pointer" }}
                  >
                    <button className="flex flex-1 min-w-0 items-center gap-3" onClick={() => enterFolder(folder)}>
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                        style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.2), rgba(0,229,255,0.1))", border: "1px solid rgba(139,92,246,0.3)" }}>
                        <Folder className="h-4 w-4" style={{ color: "#a78bfa" }} />
                      </div>
                      <span className="truncate text-[13px] font-[600]" style={{ color: "var(--text-primary)" }}>{folder.name}</span>
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button className="shrink-0 grid h-7 w-7 place-items-center rounded-lg transition" style={{ color: "#64748b" }} onClick={e => e.stopPropagation()} aria-label="Folder options">
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-[160px] overflow-hidden rounded-xl p-1 shadow-2xl" style={{ border: "1px solid var(--border-med)", background: "var(--bg-1)", backdropFilter: "blur(24px)" }}>
                          <DropdownMenu.Item onSelect={() => setFolderModal({ mode: "rename", id: folder.id, value: folder.name })} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition" style={{ color: "var(--text-primary)" }} onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--cyan-dim)"} onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}>
                            <Pencil className="h-4 w-4" style={{ color: "var(--cyan)" }} /> Rename
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onSelect={() => shareFolder(folder.id)} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition" style={{ color: "var(--text-primary)" }} onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--cyan-dim)"} onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}>
                            <Link2 className="h-4 w-4" style={{ color: "var(--cyan)" }} /> Share Folder
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onSelect={() => deleteFolder(folder.id)} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition" style={{ color: "var(--danger)" }} onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,77,109,0.08)"} onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}>
                            <Trash2 className="h-4 w-4" /> Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </motion.div>
                ))}
              </div>
            ) : null}

            {loading ? <FileSkeletonGrid view={view} /> : null}

            <motion.div layout className={cn(loading && "hidden", view === "grid" ? "grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "space-y-2")}>
              <AnimatePresence mode="popLayout">
                {files.map((file, index) => (
                  <FileTile
                    key={file.id}
                    file={file}
                    index={index}
                    grid={view === "grid"}
                    appView={appView}
                    onPreview={() => setPreviewFile(file)}
                    onDownload={() => {
                      toast.info("Preparing download…");
                      window.location.href = `/api/download/${file.id}`;
                    }}
                    onShare={() => shareFile(file.id)}
                    onDelete={() => deleteFile(file.id)}
                    onFavorite={() => toggleFavorite(file.id)}
                    onRestore={() => restoreFile(file.id)}
                  />
                ))}
              </AnimatePresence>
            </motion.div>

            {!loading && !files.length && !folders.length ? (
              <div className="rounded-2xl border p-12 text-center" style={{ borderColor: "var(--border-dim)", background: "rgba(0,229,255,0.015)" }}>
                <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl"
                  style={{ background: "linear-gradient(135deg, rgba(0,229,255,0.1), rgba(139,92,246,0.08))", border: "1px solid var(--cyan-border)" }}>
                  <CloudIcon />
                </div>
                <p className="font-[700] text-[15px]" style={{ color: "var(--text-primary)" }}>
                  {appView === "trash" ? "Trash is empty" : appView === "favorites" ? "No favorites yet" : "Nothing here yet"}
                </p>
                <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono),monospace" }}>
                  {appView === "trash" ? "Deleted files appear here" : appView === "favorites" ? "Star files to save them here" : "Upload files and they'll appear here"}
                </p>
              </div>
            ) : null}
          </motion.div>
          )}
          </AnimatePresence>
        </section>
      </motion.main>

      {/* Preview modal */}
      <AnimatePresence>
        {previewFile && (
          <PreviewModal
            file={previewFile}
            allFiles={files}
            onClose={() => setPreviewFile(null)}
            onNavigate={setPreviewFile}
          />
        )}
      </AnimatePresence>

      {/* Folder create/rename modal */}
      <AnimatePresence>
        {folderModal && (
          <FolderModal
            mode={folderModal.mode}
            initialValue={folderModal.value}
            onConfirm={submitFolderModal}
            onClose={() => setFolderModal(null)}
          />
        )}
      </AnimatePresence>

      {/* Confirm modal */}
      <AnimatePresence>
        {confirmModal && (
          <ConfirmModal
            title={confirmModal.title}
            body={confirmModal.body}
            danger={confirmModal.danger}
            onConfirm={() => { confirmModal.onConfirm(); setConfirmModal(null); }}
            onClose={() => setConfirmModal(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function FileTile({ file, grid, index, appView, onPreview, onDownload, onShare, onDelete, onFavorite, onRestore }: {
  file: DriveFile; grid: boolean; index: number; appView: AppView;
  onPreview: () => void; onDownload: () => void; onShare: () => void; onDelete: () => void;
  onFavorite: () => void; onRestore: () => void;
}) {
  const Icon = file.mimeType.startsWith("image/") ? Image : file.mimeType.startsWith("video/") ? Video : FileIcon;
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const isImage = file.mimeType.startsWith("image/");
  const isVideo = file.mimeType.startsWith("video/");
  const preview = isImage ? `/api/preview/${file.id}` : isVideo ? `/api/stream/${file.id}` : "";
  const inTrash = appView === "trash";

  const actionBtn = (color: string, hoverBg: string, hoverBorder: string) => ({
    base: { borderColor: "var(--border-med)", background: "transparent", color } as React.CSSProperties,
    hover: { borderColor: hoverBorder, background: hoverBg, color } as React.CSSProperties
  });
  const cyanBtn = actionBtn("var(--text-secondary)", "var(--cyan-dim)", "var(--cyan-border)");
  const redBtn = actionBtn("#f87171", "rgba(255,77,109,0.1)", "rgba(255,77,109,0.45)");
  const greenBtn = actionBtn("#34d399", "rgba(16,255,160,0.08)", "rgba(16,255,160,0.4)");

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ y: grid ? -3 : 0, boxShadow: "0 8px 32px rgba(0,212,255,0.12)" }}
      transition={{ type: "spring", stiffness: 380, damping: 32, delay: Math.min(index * 0.035, 0.2) }}
      className={cn("drive-card grad-border rounded-xl border p-3 transition", !grid && "flex items-center gap-3")}
      style={{ borderColor: "var(--border-dim)", background: "rgba(10,16,32,0.6)", backdropFilter: "blur(16px)" }}
    >
      <div
        className={cn("relative grid overflow-hidden place-items-center rounded-lg", grid ? "mb-3 aspect-video" : "h-12 w-12 shrink-0")}
        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", cursor: "zoom-in" }}
        onClick={onPreview}
        title="Click to preview"
      >
        {(isImage || isVideo) && !mediaLoaded ? (
          <div className="skeleton absolute inset-0" />
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
          <Icon className="h-8 w-8" style={{ color: "var(--cyan)" }} />
        )}
        {/* Star button overlay on thumbnail */}
        {grid && (
          <button
            onClick={e => { e.stopPropagation(); onFavorite(); }}
            className="absolute top-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-lg transition z-10 active:scale-90"
            style={{ background: "rgba(0,0,0,0.55)", border: file.isFavorite ? "1px solid rgba(251,191,36,0.6)" : "1px solid rgba(255,255,255,0.12)" }}
            aria-label={file.isFavorite ? "Remove from favorites" : "Add to favorites"}
            title={file.isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star className="h-3.5 w-3.5" style={{ color: file.isFavorite ? "#fbbf24" : "#64748b", fill: file.isFavorite ? "#fbbf24" : "none" }} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[13px] font-[600]" style={{ color: "var(--text-primary)" }}>{file.originalName}</h3>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono),monospace" }}>{formatBytes(file.size)} · {file.storageMode}</p>
      </div>
      {/* Desktop list view & all grid views: show action buttons */}
      <div className={cn("flex gap-1.5 items-center", grid ? "mt-3" : "ml-auto hidden sm:flex")}>
        {!grid && (
          <button
            onClick={e => { e.stopPropagation(); onFavorite(); }}
            className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
            style={{ borderColor: file.isFavorite ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.1)", background: "transparent" }}
            aria-label="Toggle favorite"
          >
            <Star className="h-4 w-4" style={{ color: file.isFavorite ? "#fbbf24" : "#94a3b8", fill: file.isFavorite ? "#fbbf24" : "none" }} />
          </button>
        )}
        {inTrash && (
          <button
            onClick={onRestore}
            className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
            style={greenBtn.base}
            onMouseEnter={e => Object.assign((e.currentTarget as HTMLElement).style, greenBtn.hover)}
            onMouseLeave={e => Object.assign((e.currentTarget as HTMLElement).style, greenBtn.base)}
            aria-label="Restore file"
            title="Restore"
          >
            <RotateCw className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={onDownload}
          className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
          style={cyanBtn.base}
          onMouseEnter={e => Object.assign((e.currentTarget as HTMLElement).style, cyanBtn.hover)}
          onMouseLeave={e => Object.assign((e.currentTarget as HTMLElement).style, cyanBtn.base)}
          aria-label="Download"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          onClick={onShare}
          className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
          style={cyanBtn.base}
          onMouseEnter={e => Object.assign((e.currentTarget as HTMLElement).style, cyanBtn.hover)}
          onMouseLeave={e => Object.assign((e.currentTarget as HTMLElement).style, cyanBtn.base)}
          aria-label="Share"
        >
          <Link2 className="h-4 w-4" />
        </button>
        <button
          onClick={onDelete}
          className="grid h-9 w-9 place-items-center rounded-lg border transition active:scale-[0.96]"
          style={redBtn.base}
          onMouseEnter={e => Object.assign((e.currentTarget as HTMLElement).style, redBtn.hover)}
          onMouseLeave={e => Object.assign((e.currentTarget as HTMLElement).style, redBtn.base)}
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
                style={{ border: "1px solid var(--border-med)", background: "var(--bg-1)", backdropFilter: "blur(24px)" }}
              >
                {inTrash && (
                  <DropdownMenu.Item
                    onSelect={onRestore}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                    style={{ color: "var(--emerald)" }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(16,255,160,0.08)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                  >
                    <RotateCw className="h-4 w-4" /> Restore
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  onSelect={onFavorite}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "var(--text-primary)" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(251,191,36,0.08)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <Star className="h-4 w-4" style={{ color: "#fbbf24", fill: file.isFavorite ? "#fbbf24" : "none" }} /> {file.isFavorite ? "Unfavorite" : "Favorite"}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onDownload}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "var(--text-primary)" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--cyan-dim)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <Download className="h-4 w-4" style={{ color: "var(--cyan)" }} /> Download
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onShare}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "var(--text-primary)" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--cyan-dim)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <Link2 className="h-4 w-4" style={{ color: "var(--cyan)" }} /> Share
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onDelete}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition"
                  style={{ color: "var(--danger)" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,77,109,0.08)"}
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
        <motion.div
          key={index}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.04, type: "spring", stiffness: 300, damping: 28 }}
          className={cn("rounded-xl border p-4", view === "list" && "flex items-center gap-4")}
          style={{ borderColor: "var(--border-dim)", background: "rgba(255,255,255,0.02)" }}
        >
          <div className={cn("skeleton rounded-lg", view === "grid" ? "mb-4 aspect-video" : "h-12 w-12 shrink-0")} />
          <div className="space-y-2 flex-1">
            <div className="skeleton h-4 rounded-md" style={{ width: "60%" }} />
            <div className="skeleton h-3 rounded-md" style={{ width: "40%" }} />
          </div>
        </motion.div>
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
      <section className="rounded-2xl border p-5" style={{ borderColor: "var(--border-dim)", background: "rgba(10,16,32,0.6)", backdropFilter: "blur(16px)" }}>
        <h2 className="font-[700] text-[15px]" style={{ color: "var(--text-primary)" }}>Appearance</h2>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { value: "light" as ThemeMode, icon: Sun, label: "Light" },
            { value: "dark" as ThemeMode, icon: Moon, label: "Dark" },
            { value: "system" as ThemeMode, icon: Monitor, label: "System" }
          ].map(item => (
            <button
              key={item.value}
              onClick={() => setTheme(item.value)}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border text-[13px] font-[500] transition active:scale-[0.95]"
              style={theme === item.value
                ? { borderColor: "var(--cyan-border)", background: "var(--cyan-dim)", color: "var(--cyan)", boxShadow: "0 0 18px rgba(0,229,255,0.15)" }
                : { borderColor: "var(--border-dim)", background: "transparent", color: "var(--text-secondary)" }
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-2xl border p-5" style={{ borderColor: "var(--border-dim)", background: "rgba(10,16,32,0.6)", backdropFilter: "blur(16px)" }}>
        <h2 className="font-[700] text-[15px]" style={{ color: "var(--text-primary)" }}>Telegram Connection</h2>
        <div className="mt-4 flex items-center gap-2 text-[13px]">
          {authStatus === "connected"
            ? <CheckCircle2 className="h-5 w-5" style={{ color: "var(--emerald)" }} />
            : <AlertCircle className="h-5 w-5" style={{ color: "var(--danger)" }} />}
          <span style={{ color: "var(--text-secondary)" }}>{authStatus === "connected" ? "Session active and authenticated" : "Session needs attention"}</span>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          If Telegram login stops working, set the production domain in BotFather and sign in again. Large personal-storage uploads require a valid GramJS session.
        </p>
        <button
          onClick={() => { window.location.href = "/"; }}
          className="btn-ripple mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border px-4 text-[13px] font-[600] transition active:scale-[0.96]"
          style={{ borderColor: "var(--cyan-border)", background: "var(--cyan-dim)", color: "var(--cyan)" }}
        >
          <RotateCw className="h-4 w-4" />
          Reconnect Telegram
        </button>
      </section>
    </motion.div>
  );
}

function CloudIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} aria-hidden="true" style={{ color: "#fff" }}>
      <path d="M12 3C9.24 3 7 5.24 7 8c0 .18.01.36.03.54A5.5 5.5 0 0 0 2 14a5.5 5.5 0 0 0 5.5 5.5h9A4.5 4.5 0 0 0 21 15a4.5 4.5 0 0 0-4.16-4.49A5.002 5.002 0 0 0 12 3Z" fill="currentColor" opacity="0.55" />
      <path d="M12 15.5V9.5m0 6-2.5-2.5M12 15.5l2.5-2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderModal({ mode, initialValue, onConfirm, onClose }: { mode: "create" | "rename"; initialValue: string; onConfirm: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initialValue);
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
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(12px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.88, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.88, opacity: 0, y: 20 }}
        transition={{ type: "spring", damping: 22, stiffness: 340 }}
        className="w-full max-w-sm rounded-2xl p-6"
        style={{ border: "1px solid rgba(0,229,255,0.18)", background: "rgba(6,11,20,0.98)", boxShadow: "0 0 50px rgba(0,229,255,0.08), 0 0 100px rgba(139,92,246,0.05)" }}
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[17px] font-[800] mb-1 gradient-text">{mode === "create" ? "New Folder" : "Rename Folder"}</h2>
        <p className="text-[12px] mb-4" style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono),monospace" }}>{mode === "create" ? "Enter a name for the new folder" : "Enter a new name"}</p>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && value.trim()) onConfirm(value.trim()); }}
          placeholder="folder-name"
          className="w-full rounded-xl px-4 py-3 text-[13px] outline-none transition"
          style={{ background: "rgba(0,229,255,0.04)", border: "1px solid var(--cyan-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono),monospace" }}
        />
        <div className="mt-4 flex gap-3 justify-end">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] font-[500] transition" style={{ border: "1px solid var(--border-med)", color: "var(--text-secondary)" }}>Cancel</button>
          <button
            onClick={() => { if (value.trim()) onConfirm(value.trim()); }}
            className="btn-ripple rounded-xl px-5 py-2 text-[13px] font-[700] transition"
            style={{ background: "linear-gradient(135deg,var(--cyan),var(--violet))", color: "#fff", boxShadow: "0 0 18px rgba(0,229,255,0.25)" }}
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AboutPanel() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* About card */}
      <div className="rounded-2xl border p-6" style={{ borderColor: "var(--border-dim)", background: "rgba(10,16,32,0.6)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-4 mb-5">
          <div className="grid h-12 w-12 place-items-center rounded-2xl shrink-0"
            style={{ background: "linear-gradient(135deg,var(--cyan),var(--violet))", boxShadow: "0 0 28px rgba(0,229,255,0.35), 0 0 56px rgba(139,92,246,0.15)" }}>
            <CloudIcon size={22} />
          </div>
          <div>
            <h2 className="text-[19px] font-[800] gradient-text">TeleDrive</h2>
            <p className="text-[12px]" style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono),monospace" }}>Personal cloud · Telegram backend</p>
          </div>
        </div>
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          TeleDrive routes files to your personal Telegram account as a backend. Files are sent to a private channel and served via a fast API — completely free, with no limits beyond Telegram&apos;s own.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {[["Storage", "Unlimited*"], ["Backend", "Telegram MTProto"], ["Hosting", "Render.com"], ["Auth", "JWT + Bot OTP"]].map(([label, val]) => (
            <div key={label} className="rounded-xl p-3" style={{ background: "rgba(0,229,255,0.04)", border: "1px solid var(--cyan-border)" }}>
              <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono),monospace" }}>{label}</p>
              <p className="text-[13px] font-[600] mt-1" style={{ color: "var(--text-primary)" }}>{val}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono),monospace" }}>* Bot ≤2GB / MTProto ≤4GB per file</p>
      </div>

      {/* Contact card */}
      <div className="rounded-2xl border p-6" style={{ borderColor: "var(--border-dim)", background: "rgba(10,16,32,0.6)", backdropFilter: "blur(16px)" }}>
        <h2 className="text-[17px] font-[800] mb-1" style={{ color: "var(--text-primary)" }}>Contact Developer</h2>
        <p className="text-[13px] mb-5" style={{ color: "var(--text-secondary)" }}>Built by Mohit Gautam. Reach out for feedback, bugs, or collaborations.</p>
        <a
          href="mailto:mohitgautam905835@gmail.com"
          className="btn-ripple flex items-center gap-3 rounded-xl px-5 py-3.5 text-[13px] font-[700] tracking-wide transition active:scale-[0.97]"
          style={{ background: "linear-gradient(135deg,var(--cyan),var(--violet))", color: "#fff", boxShadow: "0 0 24px rgba(0,229,255,0.25), 0 0 48px rgba(139,92,246,0.1)", textDecoration: "none" }}
        >
          <Mail className="h-4 w-4" />
          mohitgautam905835@gmail.com
        </a>
        <div className="mt-4 rounded-xl p-4" style={{ background: "var(--cyan-dim)", border: "1px solid var(--cyan-border)" }}>
          <p className="text-[12px] font-[600] mb-1" style={{ color: "var(--cyan)" }}>Response time</p>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>Usually within 24–48 hours. Include &ldquo;TeleDrive&rdquo; in the subject line.</p>
        </div>
        <div className="mt-3 rounded-xl p-4" style={{ background: "rgba(139,92,246,0.06)", border: "1px solid var(--violet-border)" }}>
          <p className="text-[12px] font-[600] mb-1" style={{ color: "#a78bfa" }}>Stack</p>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>Next.js · Prisma · Framer Motion · Telegram Bot / MTProto APIs</p>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, body, danger, onConfirm, onClose }: { title: string; body: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
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
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(12px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.88, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.88, opacity: 0, y: 20 }}
        transition={{ type: "spring", damping: 22, stiffness: 340 }}
        className="w-full max-w-sm rounded-2xl p-6"
        style={{ border: `1px solid ${danger ? "rgba(255,77,109,0.25)" : "rgba(0,229,255,0.18)"}`, background: "rgba(6,11,20,0.98)", boxShadow: danger ? "0 0 50px rgba(255,77,109,0.07)" : "0 0 50px rgba(0,229,255,0.07)" }}
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[17px] font-[800] mb-2" style={{ color: danger ? "var(--danger)" : "var(--text-primary)" }}>{title}</h2>
        <p className="text-[13px] mb-5 leading-relaxed" style={{ color: "var(--text-secondary)" }}>{body}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] font-[500] transition" style={{ border: "1px solid var(--border-med)", color: "var(--text-secondary)" }}>Cancel</button>
          <button
            onClick={onConfirm}
            className="btn-ripple rounded-xl px-5 py-2 text-[13px] font-[700] transition active:scale-[0.96]"
            style={{ background: danger ? "linear-gradient(135deg,#ff4d6d,#c0152b)" : "linear-gradient(135deg,var(--cyan),var(--violet))", color: "#fff", boxShadow: danger ? "0 0 18px rgba(255,77,109,0.3)" : "0 0 18px rgba(0,229,255,0.25)" }}
          >
            Confirm
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function PreviewModal({ file, allFiles, onClose, onNavigate }: {
  file: DriveFile;
  allFiles: DriveFile[];
  onClose: () => void;
  onNavigate: (file: DriveFile) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isImage = file.mimeType.startsWith("image/") && !file.mimeType.includes("heic") && !file.mimeType.includes("heif");
  const isVideo = file.mimeType.startsWith("video/");
  const previewUrl = isImage ? `/api/preview/${file.id}` : isVideo ? `/api/stream/${file.id}` : "";
  const Icon = isImage ? Image : isVideo ? Video : FileIcon;

  const previewableFiles = allFiles.filter(f => f.mimeType.startsWith("image/") || f.mimeType.startsWith("video/"));
  const currentIndex = previewableFiles.findIndex(f => f.id === file.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < previewableFiles.length - 1;

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (isFullscreen) document.exitFullscreen(); else onClose(); return; }
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && hasPrev) onNavigate(previewableFiles[currentIndex - 1]);
      if ((e.key === "ArrowRight" || e.key === "ArrowDown") && hasNext) onNavigate(previewableFiles[currentIndex + 1]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, isFullscreen, hasPrev, hasNext, currentIndex, previewableFiles, onNavigate]);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: "rgba(0,0,0,0.88)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
      onClick={onClose}
    >
      <motion.div
        ref={containerRef}
        initial={{ scale: 0.9, opacity: 0, y: 40 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 40 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="relative w-full sm:max-w-3xl rounded-t-3xl sm:rounded-2xl overflow-hidden"
        style={{ border: "1px solid var(--cyan-border)", background: "var(--bg-1)", maxHeight: "92vh", boxShadow: "0 0 60px rgba(0,229,255,0.08), 0 32px 80px rgba(0,0,0,0.5)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle bar for mobile */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full" style={{ background: "var(--border-med)" }} />
        </div>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--border-dim)" }}>
          <div className="min-w-0">
            <h3 className="truncate font-[700] text-sm" style={{ color: "var(--text-primary)" }}>{file.originalName}</h3>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono),monospace" }}>{formatBytes(file.size)} · {file.storageMode} · {file.mimeType}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => { window.location.href = `/api/download/${file.id}`; }}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-[700] transition active:scale-95"
              style={{ border: "1px solid var(--cyan-border)", background: "var(--cyan-dim)", color: "var(--cyan)" }}
            >
              <Download className="h-3.5 w-3.5" /> Download
            </button>
            <button
              onClick={toggleFullscreen}
              className="grid h-8 w-8 place-items-center rounded-xl transition active:scale-90"
              style={{ border: "1px solid var(--border-med)", color: "var(--text-secondary)" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--cyan)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--cyan-border)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-med)"; }}
              title="Toggle fullscreen (F)"
            >
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-xl transition active:scale-90"
              style={{ border: "1px solid var(--border-med)", color: "var(--text-secondary)" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--danger)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,77,109,0.35)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-med)"; }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {/* Content */}
        <div className="relative flex items-center justify-center overflow-auto" style={{ minHeight: 220, maxHeight: "74vh", padding: "1rem", background: "var(--bg-0)" }}>
          <AnimatePresence mode="wait">
            {isImage ? (
              <motion.img
                key={file.id}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ type: "spring", stiffness: 380, damping: 28 }}
                src={previewUrl}
                alt={file.originalName}
                className="rounded-xl object-contain"
                style={{ maxWidth: "100%", maxHeight: "70vh" }}
              />
            ) : isVideo ? (
              <motion.video
                key={file.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                src={previewUrl}
                controls
                autoPlay
                className="rounded-xl"
                style={{ maxWidth: "100%", maxHeight: "70vh" }}
              />
            ) : (
              <motion.div
                key="no-preview"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center py-8"
              >
                <div className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-2xl" style={{ background: "var(--cyan-dim)", border: "1px solid var(--cyan-border)" }}>
                  <Icon className="h-10 w-10" style={{ color: "var(--cyan)" }} />
                </div>
                <p className="font-[700]" style={{ color: "var(--text-secondary)" }}>No preview available</p>
                {(file.mimeType.includes("heic") || file.mimeType.includes("heif")) && (
                  <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>HEIC/HEIF isn&apos;t supported by browsers. Download to view.</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {/* Prev / Next nav arrows */}
          {hasPrev && (
            <motion.button
              whileHover={{ scale: 1.1, x: -2 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => onNavigate(previewableFiles[currentIndex - 1])}
              className="absolute left-2 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-xl"
              style={{ background: "rgba(6,11,20,0.8)", border: "1px solid var(--border-med)", color: "var(--text-primary)", backdropFilter: "blur(8px)" }}
              aria-label="Previous file"
            >
              <ChevronLeft className="h-5 w-5" />
            </motion.button>
          )}
          {hasNext && (
            <motion.button
              whileHover={{ scale: 1.1, x: 2 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => onNavigate(previewableFiles[currentIndex + 1])}
              className="absolute right-2 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-xl"
              style={{ background: "rgba(6,11,20,0.8)", border: "1px solid var(--border-med)", color: "var(--text-primary)", backdropFilter: "blur(8px)" }}
              aria-label="Next file"
            >
              <ChevronRight className="h-5 w-5" />
            </motion.button>
          )}
        </div>
        {/* Counter */}
        {previewableFiles.length > 1 && (
          <div className="flex justify-center py-2 text-[11px]" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border-dim)", fontFamily: "var(--font-mono),monospace" }}>
            {currentIndex + 1} / {previewableFiles.length} &nbsp;·&nbsp; ← → navigate &nbsp;·&nbsp; F fullscreen
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
