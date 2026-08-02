"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import {
  ArrowUpDown,
  BarChart3,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  Filter,
  Folder as FolderIcon,
  FolderInput,
  FolderUp,
  Grid2X2,
  Info,
  Link2,
  List,
  Loader2,
  LogOut,
  Menu,
  MoreVertical,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  Star,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { apiFetch, uploadFile, UploadAbortedError } from "@/lib/api-client";
import { uploadFileInChunks } from "@/lib/chunked-upload";
import { CHUNK_SIZE, MAX_FILE_SIZE } from "@/lib/upload-config";
import { canThumbnail, makeThumbnail } from "@/lib/thumbnail";
import { cn, formatBytes } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { FileTile } from "@/components/drive/file-tile";
import { filesFromDataTransfer, filesFromInput, type PickedFile } from "@/components/drive/dnd";
import { Lightbox } from "@/components/drive/lightbox";
import { ConfirmModal, MoveModal, NameModal, PropertiesModal, ShareModal } from "@/components/drive/modals";
import { AboutPanel, AuthBadge, EmptyState, InsightsPanel, SettingsPanel, SharesPanel } from "@/components/drive/panels";
import {
  formatEta,
  formatSpeed,
  type AppView,
  type DriveFile,
  type DriveFolder,
  type Insights,
  type PropsTarget,
  type SortDir,
  type SortField,
  type TelegramLink,
  type ThemeMode,
  type TypeFilter,
  type UploadItem
} from "@/components/drive/types";

const NAV: Array<{ icon: typeof FolderIcon; label: string; view: AppView }> = [
  { icon: FolderIcon, label: "My Files", view: "files" },
  { icon: Star, label: "Favourites", view: "favorites" },
  { icon: Link2, label: "Shared", view: "shared" },
  { icon: BarChart3, label: "Insights", view: "insights" },
  { icon: Trash2, label: "Trash", view: "trash" },
  { icon: SettingsIcon, label: "Settings", view: "settings" },
  { icon: Info, label: "About", view: "about" }
];

/** Views that show the file/folder browser rather than a standalone panel. */
const BROWSE_VIEWS: AppView[] = ["files", "favorites", "trash"];

export default function DriveApp({ user }: { user: { name: string; username?: string | null; avatar?: string | null } }) {
  const reduceMotion = useReducedMotion();

  const [files, setFiles] = useState<DriveFile[]>([]);
  // The whole folder tree is held once and navigation derives from it locally,
  // so opening a folder issues no folder request at all.
  const [folderTree, setFolderTree] = useState<DriveFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("folder") : null
  );
  const [folderTrail, setFolderTrail] = useState<DriveFolder[]>([]);
  const trailsByFolder = useRef<Map<string | null, DriveFolder[]>>(new Map([[null, []]]));

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [appView, setAppView] = useState<AppView>("files");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const [loading, setLoading] = useState(true);
  // Distinct from `loading`: content is on screen and being refreshed behind it,
  // so we show a hairline bar instead of blanking to skeletons.
  const [revalidating, setRevalidating] = useState(false);
  const prefetched = useRef<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const [trayOpen, setTrayOpen] = useState(true);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());
  const progressSamples = useRef<Map<string, Array<{ t: number; loaded: number }>>>(new Map());
  const batchController = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const [folderModal, setFolderModal] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; body: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [renameFile, setRenameFile] = useState<{ id: string; value: string } | null>(null);
  const [moveModal, setMoveModal] = useState<{ ids: string[] } | null>(null);
  const [propsTarget, setPropsTarget] = useState<PropsTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<{ fileId?: string; folderId?: string; name: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [authStatus, setAuthStatus] = useState<"connected" | "pending" | "failed">("pending");
  const [insights, setInsights] = useState<Insights | null>(null);
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);

  const maxBytes = link?.maxBytes ?? MAX_FILE_SIZE;
  const cacheUser = user.username || user.name;
  const cacheKey = `td:${cacheUser}:${appView}:${folderId ?? "root"}:${debouncedQuery}:${sortField}:${sortDir}:${typeFilter}`;
  const loadedKeyRef = useRef<string | null>(null);

  // ── Data loading ──────────────────────────────────────────────────────────

  const listParams = useCallback(
    (extra?: Record<string, string>) => {
      const params = new URLSearchParams();
      if (folderId) params.set("folderId", folderId);
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (appView === "favorites" || appView === "trash") params.set("view", appView);
      params.set("sort", sortField);
      params.set("dir", sortDir);
      if (typeFilter !== "all") params.set("type", typeFilter);
      for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
      return params;
    },
    [folderId, debouncedQuery, appView, sortField, sortDir, typeFilter]
  );

  /**
   * Cache key for one listing. Sort and type filter are part of it because the
   * response genuinely differs: without them, prefetching a folder while a
   * filter was active would poison the unfiltered view with a filtered list and
   * files would appear to have vanished.
   */
  const filesCacheKey = useCallback(
    (targetFolderId: string | null, view: AppView = appView, query = debouncedQuery) =>
      `td:${cacheUser}:${view}:${targetFolderId ?? "root"}:${query}:${sortField}:${sortDir}:${typeFilter}`,
    [cacheUser, appView, debouncedQuery, sortField, sortDir, typeFilter]
  );

  /** Load the folder tree once. Navigation then costs nothing. */
  const refreshFolders = useCallback(async () => {
    const key = `td:${cacheUser}:tree`;
    try {
      const cached = window.localStorage.getItem(key);
      if (cached) setFolderTree(JSON.parse(cached) as DriveFolder[]);
    } catch {
      /* corrupt cache — the network call below repairs it */
    }
    try {
      const { folders } = await apiFetch<{ folders: DriveFolder[] }>("/api/folders?flat=1", { cache: "no-store" });
      setFolderTree(folders);
      try {
        window.localStorage.setItem(key, JSON.stringify(folders));
      } catch {
        /* best-effort */
      }
    } catch {
      /* keep whatever the cache gave us */
    }
  }, [cacheUser]);

  const refresh = useCallback(async () => {
    if (!BROWSE_VIEWS.includes(appView)) return;
    const key = filesCacheKey(folderId);

    // Paint from cache immediately, then revalidate silently.
    let hasCache = false;
    try {
      const cached = window.localStorage.getItem(key);
      if (cached) {
        setFiles(JSON.parse(cached) as DriveFile[]);
        // The cache holds only the first page, and the real value arrives with
        // the refetch below. Leaving the previous folder's `true` here would let
        // the scroll sentinel fire loadMore() against the new folder mid-flight.
        setHasMore(false);
        loadedKeyRef.current = key;
        hasCache = true;
        setLoading(false);
      }
    } catch {
      /* corrupt cache — fall through to the network */
    }
    if (!hasCache) setLoading(true);
    setRevalidating(true);

    try {
      const fileData = await apiFetch<{ files: DriveFile[]; hasMore: boolean }>(
        `/api/files?${listParams({ skip: "0" })}`,
        { cache: "no-store" }
      );
      setFiles(fileData.files);
      setHasMore(Boolean(fileData.hasMore));
      loadedKeyRef.current = key;
      try {
        window.localStorage.setItem(key, JSON.stringify(fileData.files.slice(0, 48)));
      } catch {
        /* storage full — the cache is best-effort */
      }
    } catch (error) {
      if (!hasCache) toast.error(error instanceof Error ? error.message : "Could not load files.");
    } finally {
      setLoading(false);
      setRevalidating(false);
    }
  }, [folderId, appView, listParams, filesCacheKey]);

  /** Warm a folder's listing so clicking it paints instantly. */
  const prefetchFolder = useCallback(
    async (targetFolderId: string) => {
      const key = filesCacheKey(targetFolderId, "files", "");
      if (window.localStorage.getItem(key) || prefetched.current.has(key)) return;
      prefetched.current.add(key);
      try {
        const params = new URLSearchParams({ folderId: targetFolderId, sort: sortField, dir: sortDir, skip: "0" });
        if (typeFilter !== "all") params.set("type", typeFilter);
        const data = await apiFetch<{ files: DriveFile[] }>(`/api/files?${params}`, { cache: "no-store" });
        window.localStorage.setItem(key, JSON.stringify(data.files.slice(0, 48)));
      } catch {
        prefetched.current.delete(key);
      }
    },
    [filesCacheKey, sortField, sortDir, typeFilter]
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await apiFetch<{ files: DriveFile[]; hasMore: boolean }>(
        `/api/files?${listParams({ skip: String(files.length) })}`,
        { cache: "no-store" }
      );
      setFiles(prev => {
        const seen = new Set(prev.map(f => f.id));
        return [...prev, ...data.files.filter(f => !seen.has(f.id))];
      });
      setHasMore(Boolean(data.hasMore));
    } catch {
      /* keep what we have; the sentinel retries on the next scroll */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, files.length, listParams]);

  /**
   * `full` pulls the breakdown the Insights panel needs; the sidebar only wants
   * the total, and that is the cheap single-query path.
   *
   * Also re-reads the folder tree. Folder rollups (size, item count) only change
   * when files do, so tying them together means every mutation site that already
   * refreshed totals keeps the folder tiles accurate — otherwise they'd show
   * "0 items · 0 B" until a full reload, since the tree is no longer refetched
   * on navigation.
   */
  const refreshStats = useCallback(
    (full = false) => {
      apiFetch<Insights>(`/api/files/stats${full ? "?full=1" : ""}`)
        .then(data => setInsights(prev => ({ ...(prev ?? ({} as Insights)), ...data })))
        .catch(() => {});
      void refreshFolders();
    },
    [refreshFolders]
  );

  const refreshLink = useCallback(() => {
    apiFetch<TelegramLink>("/api/telegram/link").then(setLink).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    // refreshStats also pulls the folder tree.
    refreshStats();
    refreshLink();
  }, [refreshStats, refreshLink]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => entries[0]?.isIntersecting && loadMore(), { rootMargin: "700px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  useEffect(() => {
    if (loadedKeyRef.current !== cacheKey) return;
    try {
      window.localStorage.setItem(cacheKey, JSON.stringify(files.slice(0, 48)));
    } catch {
      /* best-effort */
    }
  }, [files, cacheKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setTheme((window.localStorage.getItem("teledrive-theme") as ThemeMode | null) || "system");
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    apply();
    window.localStorage.setItem("teledrive-theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    apiFetch<{ user: unknown }>("/api/auth/me")
      .then(d => setAuthStatus(d.user ? "connected" : "failed"))
      .catch(() => setAuthStatus("failed"));
  }, []);

  useEffect(() => {
    if (!uploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Upload in progress — leaving will pause it.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [uploading]);

  // ── Uploads ───────────────────────────────────────────────────────────────

  const addFileToState = useCallback(
    (created: DriveFile | null | undefined) => {
      if (!created) return;
      const here = (created.folderId ?? null) === (folderId ?? null);
      if (appView !== "files" || !here || debouncedQuery) return;
      setFiles(fs => (fs.some(f => f.id === created.id) ? fs : [created, ...fs]));
    },
    [folderId, appView, debouncedQuery]
  );

  /**
   * Resolve the folder chain a dropped directory implies, reusing folders that
   * already exist.
   *
   * Matching on the existing tree matters for more than tidiness: the resume key
   * includes the destination folder id, so minting a fresh folder on every drop
   * would give re-dropped files a new key and restart them from zero — exactly
   * the case resumable uploads exist for.
   */
  const folderCache = useRef<Map<string, string>>(new Map());
  const treeRef = useRef<DriveFolder[]>([]);
  useEffect(() => {
    treeRef.current = folderTree;
  }, [folderTree]);

  const ensureFolderPath = useCallback(async (segments: string[], rootId: string | null): Promise<string | null> => {
    let parentId = rootId;
    let key = rootId ?? "root";
    for (const segment of segments) {
      key = `${key}/${segment}`;

      const cached = folderCache.current.get(key);
      if (cached) {
        parentId = cached;
        continue;
      }

      const scope = parentId;
      const existing = treeRef.current.find(f => f.name === segment && (f.parentId ?? null) === (scope ?? null));
      if (existing) {
        folderCache.current.set(key, existing.id);
        parentId = existing.id;
        continue;
      }

      const { folder } = await apiFetch<{ folder: DriveFolder }>("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: segment, parentId })
      });
      folderCache.current.set(key, folder.id);
      treeRef.current = [...treeRef.current, folder];
      setFolderTree(fs => (fs.some(f => f.id === folder.id) ? fs : [...fs, folder]));
      parentId = folder.id;
    }
    return parentId;
  }, []);

  const uploadThumbnail = useCallback(async (fileId: string, source: File) => {
    try {
      const thumb = await makeThumbnail(source);
      if (!thumb) return;
      const form = new FormData();
      form.append("thumb", thumb);
      // Bounded: a slow thumbnail must never hold up the upload queue. If it
      // times out the server falls back to generating one on first view.
      const abort = new AbortController();
      const timer = window.setTimeout(() => abort.abort(), 15_000);
      try {
        await fetch(`/api/upload/thumb/${fileId}`, { method: "POST", body: form, signal: abort.signal });
      } finally {
        window.clearTimeout(timer);
      }
    } catch {
      /* the server still generates one on first view */
    }
  }, []);

  /**
   * Record bytes stored and derive percent, speed and ETA.
   *
   * Speed comes from a rolling ~6 s window rather than the whole-upload average,
   * so the number reacts to the connection instead of slowly converging.
   */
  const reportProgress = useCallback((itemId: string, loaded: number, size: number) => {
    const now = Date.now();
    const history = progressSamples.current.get(itemId) ?? [];
    history.push({ t: now, loaded });
    while (history.length > 2 && now - history[0].t > 6000) history.shift();
    progressSamples.current.set(itemId, history);

    const first = history[0];
    const elapsed = (now - first.t) / 1000;
    const moved = loaded - first.loaded;
    const speed = elapsed >= 0.75 && moved > 0 ? moved / elapsed : null;
    const eta = speed && speed > 0 ? Math.max(0, (size - loaded) / speed) : null;

    setUploadQueue(q =>
      q.map(it =>
        it.id === itemId
          ? { ...it, loaded, percent: size ? Math.min(100, Math.round((loaded / size) * 100)) : 0, speed, eta }
          : it
      )
    );
  }, []);

  const uploadOne = useCallback(
    async (item: UploadItem, targetFolderId: string | null) => {
      progressSamples.current.delete(item.id);
      setUploadQueue(q =>
        q.map(it => (it.id === item.id ? { ...it, status: "uploading", loaded: 0, percent: 0, error: undefined } : it))
      );
      const controller = new AbortController();
      abortControllers.current.set(item.id, controller);
      try {
        let created: DriveFile | null = null;
        if (item.file.size > CHUNK_SIZE) {
          const result = await uploadFileInChunks({
            file: item.file,
            folderId: targetFolderId,
            onProgress: loaded => reportProgress(item.id, loaded, item.size),
            signal: controller.signal
          });
          created = (result.file as DriveFile) ?? null;
        } else {
          const form = new FormData();
          form.append("file", item.file);
          if (targetFolderId) form.append("folderId", targetFolderId);
          const result = await uploadFile<{ file: DriveFile }>(
            "/api/upload",
            form,
            percent => reportProgress(item.id, Math.round((percent / 100) * item.size), item.size),
            controller.signal
          );
          created = result.data.file ?? null;
        }
        // Store the thumbnail *before* the tile mounts. The tile immediately
        // requests /api/preview?thumb=1, and if no thumbnail exists yet the
        // server takes the slow path — re-downloading the original from
        // Telegram and resizing it — which is precisely what generating one at
        // upload time is meant to avoid.
        if (created && canThumbnail(item.file)) await uploadThumbnail(created.id, item.file);
        addFileToState(created);
        progressSamples.current.delete(item.id);
        setUploadQueue(q =>
          q.map(it => (it.id === item.id ? { ...it, loaded: it.size, percent: 100, speed: null, eta: null, status: "done" } : it))
        );
      } finally {
        abortControllers.current.delete(item.id);
      }
    },
    [addFileToState, reportProgress]
  );

  const startUploads = useCallback(
    async (incoming: PickedFile[], destination: string | null = folderId) => {
      const usable = incoming.filter(p => p.file.size > 0);
      const tooLarge = usable.find(p => p.file.size > maxBytes);
      if (tooLarge) {
        toast.error(`"${tooLarge.file.name}" is larger than the ${formatBytes(maxBytes)} limit Telegram allows.`);
        return;
      }
      if (!usable.length) {
        if (incoming.length) toast.error("Those files are empty, so there was nothing to upload.");
        return;
      }

      const items: UploadItem[] = usable.map(({ file, path }) => ({
        id: Math.random().toString(36).slice(2),
        name: file.name,
        size: file.size,
        loaded: 0,
        percent: 0,
        speed: null,
        eta: null,
        status: "pending",
        file,
        path
      }));

      setUploadQueue(items);
      setTrayOpen(true);
      setUploading(true);
      const batch = new AbortController();
      batchController.current = batch;
      folderCache.current.clear();

      let failed = false;
      for (const item of items) {
        if (batch.signal.aborted) break;
        try {
          // A directory upload recreates its structure under the current folder.
          let target = destination;
          if (item.path?.includes("/")) {
            const segments = item.path.split("/").slice(0, -1);
            target = await ensureFolderPath(segments, destination);
          }
          await uploadOne(item, target);
        } catch (error) {
          if (error instanceof UploadAbortedError) {
            setUploadQueue(q => q.filter(it => it.id !== item.id));
            continue;
          }
          failed = true;
          const message = error instanceof Error ? error.message : "Upload failed";
          setUploadQueue(q => q.map(it => (it.id === item.id ? { ...it, status: "error", error: message } : it)));
        }
      }

      batchController.current = null;
      setUploading(false);
      refreshStats();
      if (!failed) window.setTimeout(() => setUploadQueue([]), 2500);
    },
    [folderId, maxBytes, uploadOne, ensureFolderPath, refreshStats]
  );

  const retryUpload = useCallback(
    async (item: UploadItem) => {
      try {
        await uploadOne(item, folderId);
      } catch (error) {
        if (error instanceof UploadAbortedError) return;
        setUploadQueue(q =>
          q.map(it => (it.id === item.id ? { ...it, status: "error", error: error instanceof Error ? error.message : "Upload failed" } : it))
        );
      }
    },
    [uploadOne, folderId]
  );

  const cancelUpload = useCallback((id: string) => {
    abortControllers.current.get(id)?.abort();
    abortControllers.current.delete(id);
    setUploadQueue(q => q.filter(it => it.id !== id));
  }, []);

  const cancelAll = useCallback(() => {
    abortControllers.current.forEach(c => c.abort());
    abortControllers.current.clear();
    batchController.current?.abort();
    setUploadQueue([]);
    setUploading(false);
  }, []);

  // ── Window-level drag and drop ────────────────────────────────────────────

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (hasFiles(e)) setDragDepth(d => d + 1);
    };
    const onLeave = (e: DragEvent) => {
      if (hasFiles(e)) setDragDepth(d => Math.max(0, d - 1));
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      setDragDepth(0);
      // Entries must be read before awaiting — the DataTransfer is neutered
      // once the event handler returns.
      filesFromDataTransfer(e.dataTransfer).then(picked => {
        if (picked.length) startUploads(picked);
      });
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [startUploads]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setSelected(new Set(files.map(f => f.id))), [files]);

  useEffect(() => {
    clearSelection();
  }, [appView, folderId, clearSelection]);

  const moveFilesTo = useCallback(
    async (ids: string[], targetFolderId: string | null) => {
      setMoveModal(null);
      if ((targetFolderId ?? null) !== (folderId ?? null)) setFiles(fs => fs.filter(f => !ids.includes(f.id)));
      clearSelection();
      try {
        await apiFetch("/api/files/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, action: "move", folderId: targetFolderId })
        });
        toast.success(ids.length > 1 ? `Moved ${ids.length} files` : "File moved");
        refreshStats();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not move.");
        refresh();
      }
    },
    [folderId, clearSelection, refreshStats, refresh]
  );

  const bulkAction = useCallback(
    async (action: "trash" | "delete" | "favorite" | "restore", ids: string[]) => {
      if (!ids.length) return;
      const removes = action !== "favorite" || appView === "favorites";
      if (removes) setFiles(fs => fs.filter(f => !ids.includes(f.id)));
      else setFiles(fs => fs.map(f => (ids.includes(f.id) ? { ...f, isFavorite: true } : f)));
      clearSelection();
      try {
        await apiFetch("/api/files/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, action })
        });
        toast.success(`${ids.length} file${ids.length > 1 ? "s" : ""} updated`);
        refreshStats();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Bulk action failed.");
        refresh();
      }
    },
    [appView, clearSelection, refreshStats, refresh]
  );

  const confirmTrash = useCallback(
    (ids: string[]) => {
      const permanent = appView === "trash";
      setConfirmModal({
        title: permanent ? "Delete forever" : "Move to trash",
        body: `${ids.length} file${ids.length > 1 ? "s" : ""} will be ${permanent ? "permanently deleted. This cannot be undone." : "moved to trash. You can restore them later."}`,
        danger: true,
        onConfirm: () => bulkAction(permanent ? "delete" : "trash", ids)
      });
    },
    [appView, bulkAction]
  );

  async function toggleFavorite(fileId: string) {
    const file = files.find(f => f.id === fileId);
    if (!file) return;
    const next = !file.isFavorite;
    setFiles(fs => (appView === "favorites" && !next ? fs.filter(f => f.id !== fileId) : fs.map(f => (f.id === fileId ? { ...f, isFavorite: next } : f))));
    try {
      await apiFetch(`/api/files/${fileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isFavorite: next })
      });
    } catch {
      setFiles(fs => fs.map(f => (f.id === fileId ? { ...f, isFavorite: !next } : f)));
      toast.error("Could not update favourite.");
    }
  }

  async function restoreFile(fileId: string) {
    // Leaves the trash list immediately; the row is put back if the server
    // disagrees, which is the same shape as trash/move/favourite above.
    const previous = files;
    setFiles(fs => fs.filter(f => f.id !== fileId));
    try {
      await apiFetch(`/api/files/${fileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restore: true })
      });
      toast.success("File restored");
      refreshStats();
    } catch (error) {
      setFiles(previous);
      toast.error(error instanceof Error ? error.message : "Could not restore file.");
    }
  }

  async function submitRenameFile(name: string) {
    if (!renameFile) return;
    const id = renameFile.id;
    setFiles(fs => fs.map(f => (f.id === id ? { ...f, originalName: name, filename: name } : f)));
    setRenameFile(null);
    try {
      await apiFetch(`/api/files/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      toast.success("File renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename file.");
      refresh();
    }
  }

  async function submitFolderModal(name: string) {
    if (!folderModal) return;
    const modal = folderModal;
    const previous = folderTree;
    // Close and paint the result straight away; the server answer only ever
    // reconciles or rolls back.
    setFolderModal(null);

    if (modal.mode === "create") {
      // A placeholder id keyed so it cannot collide with a real cuid, swapped
      // for the server's row once it arrives.
      const tempId = `pending:${Date.now()}`;
      setFolderTree(fs => [
        ...fs,
        { id: tempId, name, parentId: folderId ?? null, createdAt: new Date().toISOString(), size: 0, fileCount: 0 }
      ]);
      try {
        const { folder } = await apiFetch<{ folder: DriveFolder }>("/api/folders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, parentId: folderId })
        });
        setFolderTree(fs => fs.map(f => (f.id === tempId ? folder : f)));
        toast.success("Folder created");
      } catch (error) {
        setFolderTree(previous);
        toast.error(error instanceof Error ? error.message : "Could not create folder.");
      }
      return;
    }

    setFolderTree(fs => fs.map(f => (f.id === modal.id ? { ...f, name } : f)));
    try {
      await apiFetch(`/api/folders/${modal.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      toast.success("Folder renamed");
    } catch (error) {
      setFolderTree(previous);
      toast.error(error instanceof Error ? error.message : "Could not rename folder.");
    }
  }

  async function copyFolder(folder: DriveFolder) {
    const toastId = toast.loading(`Copying "${folder.name}"…`);
    try {
      const result = await apiFetch<{ folderCount: number; fileCount: number }>(`/api/folders/${folder.id}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      refresh();
      refreshStats();
      toast.success(
        `Copied ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} into "${folder.name} copy"`,
        { id: toastId }
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy the folder.", { id: toastId });
    }
  }

  function deleteFolder(id: string) {
    setConfirmModal({
      title: "Delete folder",
      body: "This folder and every file inside it will be moved to trash.",
      danger: true,
      onConfirm: async () => {
        try {
          await apiFetch(`/api/folders/${id}`, { method: "DELETE" });
          // Drop the folder and everything nested beneath it.
          setFolderTree(fs => {
            const doomed = new Set([id]);
            let grew = true;
            while (grew) {
              grew = false;
              for (const f of fs) {
                if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
                  doomed.add(f.id);
                  grew = true;
                }
              }
            }
            return fs.filter(f => !doomed.has(f.id));
          });
          toast.success("Folder moved to trash");
          refreshStats();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not delete folder.");
        }
      }
    });
  }

  async function createShare(options: { password?: string; expiryDays?: number }) {
    if (!shareTarget) return;
    try {
      const data = await apiFetch<{ shareUrl: string }>("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(shareTarget.fileId ? { fileId: shareTarget.fileId } : { folderId: shareTarget.folderId }),
          password: options.password ?? null,
          expiryDate: options.expiryDays ? new Date(Date.now() + options.expiryDays * 86400_000).toISOString() : null
        })
      });
      await navigator.clipboard.writeText(`${window.location.origin}${data.shareUrl}`).catch(() => {});
      toast.success("Share link created and copied");
      setShareTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the link.");
    }
  }

  function emptyTrash() {
    setConfirmModal({
      title: "Empty trash",
      body: "Permanently delete everything in trash? This cannot be undone.",
      danger: true,
      onConfirm: async () => {
        setFiles([]);
        try {
          await apiFetch("/api/files/bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "emptyTrash" })
          });
          toast.success("Trash emptied");
          refreshStats();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not empty trash.");
          refresh();
        }
      }
    });
  }

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      Object.keys(window.localStorage)
        .filter(k => k.startsWith("td:"))
        .forEach(k => window.localStorage.removeItem(k));
    } finally {
      window.location.href = "/";
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function enterFolder(folder: DriveFolder) {
    const trail = [...folderTrail, folder];
    trailsByFolder.current.set(folder.id, trail);
    setFolderTrail(trail);
    setFolderId(folder.id);
    window.history.pushState(null, "", `?folder=${folder.id}`);
  }

  function goToTrail(folder: DriveFolder | null) {
    if (!folder) {
      setFolderTrail([]);
      setFolderId(null);
      setAppView("files");
      window.history.pushState(null, "", "?");
      return;
    }
    const index = folderTrail.findIndex(f => f.id === folder.id);
    setFolderTrail(index >= 0 ? folderTrail.slice(0, index + 1) : []);
    setFolderId(folder.id);
    window.history.pushState(null, "", `?folder=${folder.id}`);
  }

  useEffect(() => {
    const onPop = () => {
      const next = new URLSearchParams(window.location.search).get("folder");
      setFolderId(next);
      setFolderTrail(trailsByFolder.current.get(next) ?? []);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function selectView(next: AppView) {
    setAppView(next);
    setSidebarOpen(false);
    if (next !== "settings") {
      setFolderId(null);
      setFolderTrail([]);
      window.history.pushState(null, "", "?");
    }
    if (next === "insights") refreshStats(true);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  const modalOpen = Boolean(previewFile || folderModal || confirmModal || moveModal || renameFile || propsTarget || shareTarget);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing || modalOpen) return;
      if (e.key === "/" ) {
        e.preventDefault();
        (document.getElementById("drive-search") as HTMLInputElement | null)?.focus();
      } else if (e.key === "Escape" && selected.size) {
        clearSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && files.length) {
        e.preventDefault();
        selectAll();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
        confirmTrash([...selected]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modalOpen, selected, files.length, clearSelection, selectAll, confirmTrash]);

  // ── Derived ───────────────────────────────────────────────────────────────

  // Children of the current folder, straight from the in-memory tree.
  const folders = useMemo(
    () => folderTree.filter(f => (f.parentId ?? null) === (folderId ?? null)).sort((a, b) => a.name.localeCompare(b.name)),
    [folderTree, folderId]
  );

  // Weighted by bytes, not a mean of per-file percentages — otherwise one tiny
  // finished file next to a 4 GB one would read 50%.
  const overallPercent = useMemo(() => {
    const total = uploadQueue.reduce((sum, item) => sum + item.size, 0);
    if (!total) return 0;
    const loaded = uploadQueue.reduce((sum, item) => sum + (item.status === "done" ? item.size : item.loaded), 0);
    return Math.round((loaded / total) * 100);
  }, [uploadQueue]);

  const heading =
    appView === "files"
      ? folderTrail.length
        ? folderTrail[folderTrail.length - 1].name
        : "My Files"
      : NAV.find(n => n.view === appView)?.label ?? "My Files";

  const browsing = BROWSE_VIEWS.includes(appView);

  return (
    <div className="app-bg relative min-h-[100dvh]">
      {/* Hidden pickers */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={e => {
          startUploads(filesFromInput(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={node => {
          // Set as attributes on the live node: React drops unknown camelCase
          // props, and the spelling differs between engines.
          if (node) {
            node.setAttribute("webkitdirectory", "");
            node.setAttribute("directory", "");
            node.setAttribute("mozdirectory", "");
          }
          dirInputRef.current = node;
        }}
        type="file"
        multiple
        hidden
        onChange={e => {
          startUploads(filesFromInput(e.target.files));
          e.target.value = "";
        }}
      />

      {/* Sidebar scrim */}
      <AnimatePresence>
        {sidebarOpen ? (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 lg:hidden"
            style={{ background: "rgba(3,5,10,0.6)" }}
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      {/* ── Sidebar ── */}
      <aside
        className={cn(
          "frost fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-[268px] flex-col px-4 py-5 transition-transform duration-300 lg:w-[268px] lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ borderRight: "1px solid var(--border-dim)", willChange: "transform" }}
      >
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo size={30} />
            <div className="min-w-0">
              <p className="display truncate text-[15px] leading-none">TeleDrive</p>
              <p className="eyebrow mt-1">Personal cloud</p>
            </div>
          </div>
          <button className="icon-btn lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex gap-2">
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="btn btn-primary flex-1" style={{ minHeight: 42 }}>
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <button onClick={() => dirInputRef.current?.click()} disabled={uploading} className="btn btn-ghost" style={{ minHeight: 42, width: 42, padding: 0 }} aria-label="Upload a folder" title="Upload a folder">
            <FolderUp className="h-4 w-4" />
          </button>
        </div>

        <UploadTray
          items={uploadQueue}
          uploading={uploading}
          open={trayOpen}
          onToggle={() => setTrayOpen(o => !o)}
          onCancel={cancelUpload}
          onCancelAll={cancelAll}
          onRetry={retryUpload}
          onDismiss={id => setUploadQueue(q => q.filter(it => it.id !== id))}
        />

        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto pb-3">
          {NAV.map(({ icon: Icon, label, view: navView }) => (
            <button key={navView} onClick={() => selectView(navView)} className="nav-item" data-active={appView === navView}>
              {appView === navView ? (
                <motion.span
                  layoutId="nav-rail"
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full"
                  style={{ background: "var(--accent-grad)" }}
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}
              <Icon className="h-4 w-4 shrink-0" style={{ color: appView === navView ? "var(--accent)" : undefined }} />
              {label}
            </button>
          ))}
        </nav>

        <div className="rounded-xl p-3.5" style={{ background: "var(--surface)", border: "1px solid var(--border-dim)" }}>
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-bold" style={{ background: "var(--accent-grad)", color: "#04070c" }}>
              {user.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="t-sm truncate font-semibold" style={{ color: "var(--text-1)" }}>{user.name}</p>
              <p className="mono truncate" style={{ color: "var(--text-3)" }}>{user.username ? `@${user.username}` : "Telegram"}</p>
            </div>
            <button onClick={logout} className="icon-btn icon-btn-danger" style={{ height: 32, width: 32 }} aria-label="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--border-dim)", paddingTop: 10 }}>
            <span className="t-xs flex items-center gap-1.5" style={{ color: "var(--text-3)" }}>
              <AuthBadge status={authStatus} />
              {authStatus === "connected" ? "Connected" : authStatus === "failed" ? "Reconnect" : "Checking"}
            </span>
            <span className="chip">{formatBytes(insights?.totalSize ?? 0)}</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="lg:pl-[268px]">
        <header className="frost sticky top-0 z-30" style={{ borderBottom: "1px solid var(--border-dim)" }}>
          <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
            <button className="icon-btn lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <Menu className="h-4 w-4" />
            </button>

            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--text-3)" }} />
              <input
                id="drive-search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search files…"
                aria-label="Search files"
                className="field pl-9"
                style={{ height: 38 }}
              />
            </div>

            {uploading ? (
              <div className="hidden items-center gap-2 sm:flex">
                <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: "var(--surface)" }}>
                  <div className="progress-bar h-full rounded-full transition-[width] duration-300" style={{ width: `${overallPercent}%` }} />
                </div>
                <span className="mono" style={{ color: "var(--accent)" }}>{overallPercent}%</span>
              </div>
            ) : null}

            <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="btn btn-primary lg:hidden" aria-label="Upload files">
              <Upload className="h-4 w-4" />
            </button>
          </div>

          {uploading || revalidating ? <div className="progress-bar h-[2px] w-full" /> : null}
        </header>

        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-7">
          {/* Title row */}
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              {browsing && appView === "files" ? (
                <nav className="mono mb-1.5 flex flex-wrap items-center gap-1" aria-label="Breadcrumb" style={{ color: "var(--text-3)" }}>
                  <button onClick={() => goToTrail(null)} className="link-underline">Home</button>
                  {folderTrail.map(folder => (
                    <span key={folder.id} className="flex items-center gap-1">
                      <ChevronRight className="h-3 w-3" />
                      <button onClick={() => goToTrail(folder)} className="link-underline">{folder.name}</button>
                    </span>
                  ))}
                </nav>
              ) : null}
              <h1 className="display t-h1 truncate">{heading}</h1>
            </div>

            {browsing ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {appView === "trash" ? (
                  <button onClick={emptyTrash} disabled={!files.length} className="btn btn-danger">
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Empty trash</span>
                  </button>
                ) : (
                  <button onClick={() => setFolderModal({ mode: "create", value: "" })} className="btn btn-ghost">
                    <Plus className="h-4 w-4" />
                    <span className="hidden sm:inline">New folder</span>
                  </button>
                )}

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className="btn btn-ghost" style={{ color: typeFilter === "all" ? undefined : "var(--accent)" }} aria-label="Filter by type">
                      <Filter className="h-4 w-4" />
                      <span className="hidden md:inline">{typeFilter === "all" ? "All" : typeFilter === "doc" ? "Docs" : `${typeFilter}s`}</span>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={6} className="menu">
                      {(["all", "image", "video", "doc"] as TypeFilter[]).map(value => (
                        <DropdownMenu.Item key={value} onSelect={() => setTypeFilter(value)} className="menu-item" style={{ color: typeFilter === value ? "var(--accent)" : undefined }}>
                          {value === "all" ? "All files" : value === "doc" ? "Documents" : `${value[0].toUpperCase()}${value.slice(1)}s`}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className="btn btn-ghost" aria-label="Sort">
                      <ArrowUpDown className="h-4 w-4" />
                      <span className="hidden md:inline">{sortField === "date" ? "Date" : sortField === "name" ? "Name" : "Size"}</span>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={6} className="menu">
                      {(["date", "name", "size"] as SortField[]).map(field => (
                        <DropdownMenu.Item
                          key={field}
                          onSelect={() => {
                            if (sortField === field) setSortDir(d => (d === "asc" ? "desc" : "asc"));
                            else {
                              setSortField(field);
                              setSortDir(field === "name" ? "asc" : "desc");
                            }
                          }}
                          className="menu-item justify-between"
                          style={{ color: sortField === field ? "var(--accent)" : undefined }}
                        >
                          {field === "date" ? "Date" : field === "name" ? "Name" : "Size"}
                          {sortField === field ? <span className="mono">{sortDir === "asc" ? "↑" : "↓"}</span> : null}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                <div className="flex overflow-hidden rounded-xl" style={{ border: "1px solid var(--border-dim)" }}>
                  {([["grid", Grid2X2], ["list", List]] as Array<["grid" | "list", typeof Grid2X2]>).map(([mode, Icon]) => (
                    <button
                      key={mode}
                      onClick={() => setView(mode)}
                      className="grid h-9 w-9 place-items-center transition"
                      style={{ background: view === mode ? "var(--accent-dim)" : "transparent", color: view === mode ? "var(--accent)" : "var(--text-3)" }}
                      aria-label={`${mode} view`}
                      aria-pressed={view === mode}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Content.
              Deliberately not wrapped in AnimatePresence: the files branch has
              its own nested AnimatePresence, and a parent in `mode="wait"`
              deadlocks waiting for an exit that the nested one swallows — the
              old view stays on screen forever. Re-keying gives the same
              transition feel with none of that risk. */}
          <div key={`${appView}-${folderId ?? "root"}`}>
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              {appView === "settings" ? (
                <SettingsPanel theme={theme} setTheme={setTheme} link={link} onLinkChanged={refreshLink} />
              ) : appView === "about" ? (
                <AboutPanel maxBytes={maxBytes} />
              ) : appView === "shared" ? (
                <SharesPanel />
              ) : appView === "insights" ? (
                <InsightsPanel
                  insights={insights}
                  onOpenFile={id => {
                    const file = files.find(f => f.id === id);
                    if (file) setPreviewFile(file);
                    else window.location.href = `/api/download/${id}`;
                  }}
                />
              ) : (
                <>
                  {/* Folders — only in the browsable root view. Favourites and
                      Trash list files across folders, and the folder state may
                      still hold the previous view's rows while it refetches. */}
                  {appView === "files" && folders.length ? (
                    // Full width on phones: two-up truncates the size line.
                    <div className="mb-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {folders.map((folder, i) => (
                        <div
                          key={folder.id}
                          className={cn("card rise relative flex items-center gap-2.5 p-3", dropFolderId === folder.id && "drop-target")}
                          style={{ ["--i" as string]: i }}
                          onDragOver={e => {
                            if (e.dataTransfer.types.includes("application/x-teledrive-files") || e.dataTransfer.types.includes("Files")) {
                              e.preventDefault();
                              e.stopPropagation();
                              setDropFolderId(folder.id);
                            }
                          }}
                          onDragLeave={() => setDropFolderId(current => (current === folder.id ? null : current))}
                          onDrop={e => {
                            const payload = e.dataTransfer.getData("application/x-teledrive-files");
                            setDropFolderId(null);
                            if (payload) {
                              e.preventDefault();
                              e.stopPropagation();
                              const ids = payload === '"selection"' || payload === "selection" ? [...selected] : (JSON.parse(payload) as string[]);
                              if (ids.length) moveFilesTo(ids, folder.id);
                              return;
                            }
                            if (e.dataTransfer.files?.length || e.dataTransfer.items?.length) {
                              e.preventDefault();
                              e.stopPropagation();
                              setDragDepth(0);
                              filesFromDataTransfer(e.dataTransfer).then(picked => {
                                if (picked.length) startUploads(picked, folder.id);
                              });
                            }
                          }}
                        >
                          <button
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                            onClick={() => enterFolder(folder)}
                            // Warm the listing before the click lands, so the
                            // folder opens against a populated cache.
                            onMouseEnter={() => prefetchFolder(folder.id)}
                            onFocus={() => prefetchFolder(folder.id)}
                            onTouchStart={() => prefetchFolder(folder.id)}
                          >
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: "rgba(129,140,248,0.12)", border: "1px solid rgba(129,140,248,0.24)" }}>
                              <FolderIcon className="h-4 w-4" style={{ color: "var(--accent-2)" }} />
                            </span>
                            <span className="min-w-0">
                              <span className="t-sm block truncate font-semibold" style={{ color: "var(--text-1)" }}>{folder.name}</span>
                              <span className="mono block truncate" style={{ color: "var(--text-3)" }}>
                                {folder.fileCount ?? 0} item{(folder.fileCount ?? 0) === 1 ? "" : "s"} · {formatBytes(folder.size ?? 0)}
                              </span>
                            </span>
                          </button>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                              <button className="icon-btn shrink-0" style={{ height: 30, width: 30 }} aria-label={`Options for ${folder.name}`}>
                                <MoreVertical className="h-4 w-4" />
                              </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content align="end" sideOffset={6} className="menu">
                                <DropdownMenu.Item onSelect={() => setPropsTarget({ kind: "folder", folder })} className="menu-item">
                                  <Info className="h-4 w-4" style={{ color: "var(--accent)" }} /> Properties
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => setFolderModal({ mode: "rename", id: folder.id, value: folder.name })} className="menu-item">
                                  <Pencil className="h-4 w-4" style={{ color: "var(--accent)" }} /> Rename
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => copyFolder(folder)} className="menu-item">
                                  <Copy className="h-4 w-4" style={{ color: "var(--accent)" }} /> Make a copy
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => setShareTarget({ folderId: folder.id, name: folder.name })} className="menu-item">
                                  <Link2 className="h-4 w-4" style={{ color: "var(--accent)" }} /> Share folder
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => deleteFolder(folder.id)} className="menu-item menu-item-danger">
                                  <Trash2 className="h-4 w-4" /> Delete
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu.Root>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Files */}
                  {loading ? (
                    <SkeletonGrid view={view} />
                  ) : files.length ? (
                    <div className={view === "grid" ? "grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "space-y-2"}>
                      <AnimatePresence mode="popLayout">
                        {files.map((file, index) => (
                          <FileTile
                            key={file.id}
                            file={file}
                            index={index}
                            grid={view === "grid"}
                            inTrash={appView === "trash"}
                            selected={selected.has(file.id)}
                            selectionActive={selected.size > 0}
                            mtprotoUserId={link?.telegramUserId ?? null}
                            actions={{
                              onPreview: () => setPreviewFile(file),
                              onDownload: () => {
                                window.location.href = `/api/download/${file.id}`;
                              },
                              onShare: () => setShareTarget({ fileId: file.id, name: file.originalName }),
                              onDelete: () => confirmTrash([file.id]),
                              onFavorite: () => toggleFavorite(file.id),
                              onRestore: () => restoreFile(file.id),
                              onRename: () => setRenameFile({ id: file.id, value: file.originalName }),
                              onMove: () => setMoveModal({ ids: selected.has(file.id) ? [...selected] : [file.id] }),
                              onProperties: () => setPropsTarget({ kind: "file", file }),
                              onToggleSelect: () => toggleSelect(file.id)
                            }}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  ) : folders.length ? null : (
                    <EmptyState
                      icon={<Cloud className="h-7 w-7" style={{ color: "var(--accent)" }} />}
                      title={appView === "trash" ? "Trash is empty" : appView === "favorites" ? "No favourites yet" : "Nothing here yet"}
                      body={
                        appView === "trash"
                          ? "Deleted files rest here until you empty the trash."
                          : appView === "favorites"
                            ? "Star a file and it will show up here."
                            : `Drop files anywhere on this page, or upload a whole folder. Up to ${formatBytes(maxBytes)} per file.`
                      }
                      action={
                        appView === "files" ? (
                          <button onClick={() => fileInputRef.current?.click()} className="btn btn-primary">
                            <Upload className="h-4 w-4" /> Upload files
                          </button>
                        ) : undefined
                      }
                    />
                  )}

                  {!loading && hasMore ? (
                    <div ref={sentinelRef} className="flex items-center justify-center gap-3 py-8">
                      <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--accent)" }} />
                      <span className="mono" style={{ color: "var(--text-3)" }}>{loadingMore ? "Loading more…" : "Scroll for more"}</span>
                    </div>
                  ) : null}
                </>
              )}
            </motion.div>
          </div>
        </main>
      </div>

      {/* ── Bulk action bar ──
          Horizontally scrollable so it can never overflow a narrow screen. */}
      <AnimatePresence>
        {selected.size ? (
          <motion.div
            initial={{ y: 70, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 70, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="safe-bottom fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 lg:left-[268px]"
          >
            <div
              className="no-scrollbar mx-auto flex max-w-fit items-center gap-1.5 overflow-x-auto rounded-2xl px-2.5 py-2"
              style={{ background: "var(--bg-2)", border: "1px solid var(--border-med)", boxShadow: "var(--shadow-lg)" }}
            >
              <span className="t-sm shrink-0 px-1.5 font-bold" style={{ color: "var(--accent)" }}>{selected.size}</span>
              {selected.size < files.length ? (
                <button onClick={selectAll} className="btn btn-ghost shrink-0">
                  <Check className="h-4 w-4" />
                  <span className="hidden sm:inline">All ({files.length})</span>
                </button>
              ) : null}
              <button
                onClick={() => {
                  [...selected].forEach((id, i) =>
                    window.setTimeout(() => {
                      const a = document.createElement("a");
                      a.href = `/api/download/${id}`;
                      a.download = "";
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }, i * 400)
                  );
                  toast.info(`Downloading ${selected.size} file${selected.size > 1 ? "s" : ""}…`);
                }}
                className="btn btn-ghost shrink-0"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download</span>
              </button>
              {appView !== "trash" ? (
                <button onClick={() => setMoveModal({ ids: [...selected] })} className="btn btn-ghost shrink-0">
                  <FolderInput className="h-4 w-4" />
                  <span className="hidden sm:inline">Move</span>
                </button>
              ) : (
                <button onClick={() => bulkAction("restore", [...selected])} className="btn btn-ghost shrink-0" style={{ color: "var(--emerald)" }}>
                  <RotateCw className="h-4 w-4" />
                  <span className="hidden sm:inline">Restore</span>
                </button>
              )}
              {appView !== "trash" ? (
                <button onClick={() => bulkAction("favorite", [...selected])} className="btn btn-ghost shrink-0" style={{ color: "var(--amber)" }}>
                  <Star className="h-4 w-4" />
                  <span className="hidden sm:inline">Favourite</span>
                </button>
              ) : null}
              <button onClick={() => confirmTrash([...selected])} className="btn btn-danger shrink-0">
                <Trash2 className="h-4 w-4" />
                <span className="hidden sm:inline">Delete</span>
              </button>
              <button onClick={clearSelection} className="icon-btn shrink-0" aria-label="Clear selection">
                <X className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Global drop overlay ── */}
      <AnimatePresence>
        {dragDepth > 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-[65] flex items-center justify-center p-6"
            style={{ background: "rgba(3,5,10,0.72)" }}
          >
            <div className="panel px-8 py-10 text-center" style={{ borderStyle: "dashed", borderColor: "var(--accent)" }}>
              <Upload className="mx-auto h-8 w-8" style={{ color: "var(--accent)" }} />
              <p className="display t-h2 mt-4">Drop to upload</p>
              <p className="t-sm mt-1" style={{ color: "var(--text-3)" }}>Release over a folder to put them straight inside it.</p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Overlays ── */}
      <AnimatePresence>
        {previewFile ? <Lightbox file={previewFile} allFiles={files} onClose={() => setPreviewFile(null)} onNavigate={setPreviewFile} /> : null}
      </AnimatePresence>
      <AnimatePresence>
        {folderModal ? (
          <NameModal
            title={folderModal.mode === "create" ? "New folder" : "Rename folder"}
            hint={folderModal.mode === "create" ? "Name the folder." : "Give it a new name."}
            initialValue={folderModal.value}
            confirmLabel={folderModal.mode === "create" ? "Create" : "Save"}
            onConfirm={submitFolderModal}
            onClose={() => setFolderModal(null)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {renameFile ? (
          <NameModal
            title="Rename file"
            hint="Only the name in TeleDrive changes."
            initialValue={renameFile.value}
            confirmLabel="Save"
            onConfirm={submitRenameFile}
            onClose={() => setRenameFile(null)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {confirmModal ? (
          <ConfirmModal
            title={confirmModal.title}
            body={confirmModal.body}
            danger={confirmModal.danger}
            onConfirm={() => {
              confirmModal.onConfirm();
              setConfirmModal(null);
            }}
            onClose={() => setConfirmModal(null)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {moveModal ? (
          <MoveModal count={moveModal.ids.length} currentFolderId={folderId} onMove={target => moveFilesTo(moveModal.ids, target)} onClose={() => setMoveModal(null)} />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>{propsTarget ? <PropertiesModal target={propsTarget} onClose={() => setPropsTarget(null)} /> : null}</AnimatePresence>
      <AnimatePresence>
        {shareTarget ? <ShareModal targetName={shareTarget.name} onCreate={createShare} onClose={() => setShareTarget(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

// ── Upload tray ─────────────────────────────────────────────────────────────

function UploadTray({
  items,
  uploading,
  open,
  onToggle,
  onCancel,
  onCancelAll,
  onRetry,
  onDismiss
}: {
  items: UploadItem[];
  uploading: boolean;
  open: boolean;
  onToggle: () => void;
  onCancel: (id: string) => void;
  onCancelAll: () => void;
  onRetry: (item: UploadItem) => void;
  onDismiss: (id: string) => void;
}) {
  if (!items.length) return null;
  const done = items.filter(i => i.status === "done").length;
  const failed = items.filter(i => i.status === "error").length;

  // Queue totals: bytes moved across every file, and a combined rate/ETA taken
  // from whatever is actually in flight.
  const totalBytes = items.reduce((sum, i) => sum + i.size, 0);
  const loadedBytes = items.reduce((sum, i) => sum + (i.status === "done" ? i.size : i.loaded), 0);
  const activeSpeed = items.reduce((sum, i) => sum + (i.status === "uploading" ? (i.speed ?? 0) : 0), 0);
  const queueEta = activeSpeed > 0 ? (totalBytes - loadedBytes) / activeSpeed : null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-3 overflow-hidden rounded-xl"
      style={{ border: "1px solid var(--border-dim)", background: "var(--surface)" }}
    >
      <div className="px-3 py-2" style={{ borderBottom: open ? "1px solid var(--border-dim)" : "none" }}>
        <div className="flex items-center justify-between gap-2">
          <button onClick={onToggle} className="t-xs flex min-w-0 items-center gap-1.5" style={{ color: "var(--text-2)" }}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
            <span className="truncate">
              {done}/{items.length} done{failed ? ` · ${failed} failed` : ""}
            </span>
          </button>
          {uploading ? (
            <button onClick={onCancelAll} className="t-xs shrink-0 font-semibold" style={{ color: "var(--danger)" }}>
              Cancel all
            </button>
          ) : null}
        </div>
        <p className="mono mt-1 truncate" style={{ color: "var(--text-3)" }}>
          {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
          {uploading ? ` · ${formatSpeed(activeSpeed || null)} · ${formatEta(queueEta)} left` : ""}
        </p>
      </div>

      {open ? (
        <div className="max-h-44 space-y-1.5 overflow-y-auto p-2">
          {items.map(item => (
            <div key={item.id} className="rounded-lg p-2" style={{ background: "var(--bg-1)" }}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="t-xs truncate font-medium" style={{ color: "var(--text-1)" }} title={item.path || item.name}>
                  {item.name}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.status === "pending" ? <span className="mono" style={{ color: "var(--text-3)" }}>wait</span> : null}
                  {item.status === "uploading" ? <span className="mono" style={{ color: "var(--accent)" }}>{item.percent}%</span> : null}
                  {item.status === "done" ? <Check className="h-3.5 w-3.5" style={{ color: "var(--emerald)" }} /> : null}
                  {item.status === "error" ? (
                    <button onClick={() => onRetry(item)} aria-label="Retry upload">
                      <RotateCw className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
                    </button>
                  ) : null}
                  <button
                    onClick={() => (item.status === "uploading" || item.status === "pending" ? onCancel(item.id) : onDismiss(item.id))}
                    aria-label="Remove from queue"
                  >
                    <X className="h-3.5 w-3.5" style={{ color: "var(--text-3)" }} />
                  </button>
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full" style={{ background: "var(--surface-hi)" }}>
                <div
                  className={cn("h-full rounded-full transition-[width] duration-300", item.status === "uploading" && "progress-bar")}
                  style={{
                    width: `${item.status === "done" ? 100 : item.percent}%`,
                    background:
                      item.status === "error" ? "var(--danger)" : item.status === "done" ? "var(--emerald)" : undefined
                  }}
                />
              </div>
              {item.status === "error" ? (
                <p className="t-xs mt-1 truncate" style={{ color: "var(--danger)" }} title={item.error}>{item.error}</p>
              ) : (
                <p className="mono mt-1 truncate" style={{ color: "var(--text-3)" }}>
                  {formatBytes(item.status === "done" ? item.size : item.loaded)} / {formatBytes(item.size)}
                  {item.status === "uploading" && item.speed ? ` · ${formatSpeed(item.speed)} · ${formatEta(item.eta)}` : ""}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </motion.div>
  );
}

function SkeletonGrid({ view }: { view: "grid" | "list" }) {
  return (
    <div className={view === "grid" ? "grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "space-y-2"}>
      {Array.from({ length: view === "grid" ? 10 : 6 }).map((_, i) => (
        <div key={i} className={cn("card p-3", view === "list" && "flex items-center gap-3")}>
          <div className={cn("skeleton", view === "grid" ? "mb-3 aspect-[4/3] w-full" : "h-11 w-11 shrink-0")} />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-3/5" />
            <div className="skeleton h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
