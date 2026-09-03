"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import { apiFetch } from "@/lib/api-client";
import { uploads } from "@/lib/upload-manager";
import { resumeKeyFor } from "@/lib/chunked-upload";
import { MAX_FILE_SIZE } from "@/lib/upload-config";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_DEFAULT,
  applyAccent,
  applyReducedMotion,
  setPreference,
  usePreferences
} from "@/lib/preferences";
import { cn, formatBytes } from "@/lib/utils";
import { SPRING, fadeIn, fadeUp, riseFromBottom, transition, useReducedMotion } from "@/lib/motion";
import { Logo } from "@/components/logo";
import { FileTile } from "@/components/drive/file-tile";
import { filesFromDataTransfer, filesFromInput, rememberDroppedHandles, type PickedFile } from "@/components/drive/dnd";
import { Lightbox } from "@/components/drive/lightbox";
import { ConfirmModal, MoveModal, NameModal, PropertiesModal, ShareModal } from "@/components/drive/modals";
import { AboutPanel, AuthBadge, EmptyState, InsightsPanel, SettingsPanel, SharesPanel } from "@/components/drive/panels";
import { AiSearchResults, AiSearchToggle, AskAiPanel, type AiAction } from "@/components/drive/ai";
import { TransferPanel } from "@/components/drive/transfers";
import { MEMORY_DOWNLOAD_LIMIT, browserDownload, canStreamToDisk, downloadWithProgress } from "@/lib/download-manager";
import {
  type AiSearchHit,
  type AppView,
  type DownloadItem,
  type DriveFile,
  type DriveFolder,
  type Insights,
  type PropsTarget,
  type SortDir,
  type SortField,
  type TelegramLink,
  type ThemeMode,
  type TransferItem,
  type TypeFilter,
  sampleRate
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

/** Long enough that a typed word is one request, short enough that the results
 *  feel like they are keeping up. */
const SEARCH_DEBOUNCE_MS = 300;

/** `useLayoutEffect`, minus the warning React prints when it is rendered on the
 *  server. Nothing here runs during SSR, so falling back to useEffect is safe. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function DriveApp({ user }: { user: { name: string; username?: string | null; avatar?: string | null } }) {
  const reduceMotion = useReducedMotion();

  const [files, setFiles] = useState<DriveFile[]>([]);
  // The whole folder tree is held once and navigation derives from it locally,
  // so opening a folder issues no folder request at all.
  const [folderTree, setFolderTree] = useState<DriveFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("folder") : null
  );
  // Distinguishes "no folders" from "not loaded yet" — an empty tree and a tree
  // still in flight look identical otherwise, and one of them wants skeletons.
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [folderTrail, setFolderTrail] = useState<DriveFolder[]>([]);
  const trailsByFolder = useRef<Map<string | null, DriveFolder[]>>(new Map([[null, []]]));

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // ── AI, only if the server says it exists ─────────────────────────────────
  // `aiAvailable` starts false so nothing AI-shaped can flash on a server where
  // the flag is off; /api/overview answers it with the rest of the page load.
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiSearch, setAiSearch] = useState(false);
  const [aiHits, setAiHits] = useState<AiSearchHit[] | null>(null);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiSearchedFor, setAiSearchedFor] = useState("");
  const [askAi, setAskAi] = useState<{ file: DriveFile; action?: AiAction } | null>(null);
  const aiController = useRef<AbortController | null>(null);
  /**
   * Saved settings. The defaults below are only what the *session* starts at —
   * sort and view can be changed for one visit without rewriting the preference,
   * which is why they are still component state seeded from it.
   */
  const prefs = usePreferences();
  const [view, setView] = useState<"grid" | "list">(prefs.view);
  const [appView, setAppView] = useState<AppView>("files");
  const [sortField, setSortField] = useState<SortField>(prefs.sortField);
  const [sortDir, setSortDir] = useState<SortDir>(prefs.sortDir);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const [loading, setLoading] = useState(true);
  // Distinct from `loading`: content is on screen and being refreshed behind it,
  // so we show a hairline bar instead of blanking to skeletons.
  const [revalidating, setRevalidating] = useState(false);
  const prefetched = useRef<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // The queue lives in a module, not in this component: uploads have to keep
  // running when this tree unmounts (see lib/upload-manager.ts).
  const uploadQueue = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getServerSnapshot);
  const uploading = uploadQueue.some(it => it.status === "uploading" || it.status === "pending");
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [trayOpen, setTrayOpen] = useState(true);
  const downloadControllers = useRef<Map<string, AbortController>>(new Map());
  /** The in-flight listing, so a newer one can cancel it. */
  const listController = useRef<AbortController | null>(null);
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
  // Folders are selectable alongside files so several can be zipped together.
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());

  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Starts at the default and is corrected before the first paint, below. A
  // lazy initialiser cannot do this: the server renders the default, and React
  // keeps the server's markup during hydration, so the remembered width was
  // stored in state while the DOM stayed at 268px.
  const [sidebarWidth, setSidebarWidth] = useState(prefs.sidebarWidth);
  const [resizing, setResizing] = useState(false);
  const theme = prefs.theme;
  const setTheme = useCallback((next: ThemeMode) => setPreference("theme", next), []);
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
      params.set("take", String(prefs.pageSize));
      for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
      return params;
    },
    [folderId, debouncedQuery, appView, sortField, sortDir, typeFilter, prefs.pageSize]
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
      if (cached) {
        setFolderTree(JSON.parse(cached) as DriveFolder[]);
        setTreeLoaded(true);
      }
    } catch {
      /* corrupt cache — the network call below repairs it */
    }
    try {
      const { folders } = await apiFetch<{ folders: DriveFolder[] }>("/api/folders?flat=1", { cache: "no-store" });
      setFolderTree(folders);
      setTreeLoaded(true);
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

    // A superseded listing is dead weight: it still occupies a database
    // connection, and its response would overwrite the newer one if it landed
    // late. Typing in the search box is where that mattered most — each debounced
    // query replaced the last, and without this the requests stacked up.
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;

    try {
      const fileData = await apiFetch<{ files: DriveFile[]; hasMore: boolean }>(
        `/api/files?${listParams({ skip: "0" })}`,
        { cache: "no-store", signal: controller.signal }
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
      // Cancelling our own request is the normal path, not a failure to report.
      if (controller.signal.aborted) return;
      if (!hasCache) toast.error(error instanceof Error ? error.message : "Could not load files.");
    } finally {
      if (listController.current === controller) {
        listController.current = null;
        setLoading(false);
        setRevalidating(false);
      }
    }
  }, [folderId, appView, listParams, filesCacheKey]);

  /**
   * Semantic search, run on Enter rather than as you type.
   *
   * Deliberately not debounced into firing by itself: each run embeds the query
   * through the user's own provider key and scans every indexed slice, so a
   * request per pause would spend their credits on half-typed words. Filename
   * search stays instant; meaning search waits to be asked.
   */
  const runAiSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;

    setAiSearching(true);
    setAiSearchedFor(q);
    try {
      const data = await apiFetch<{ hits: AiSearchHit[] }>("/api/ai/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, limit: 20 }),
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setAiHits(data.hits ?? []);
    } catch (error) {
      if (controller.signal.aborted) return;
      setAiHits([]);
      toast.error(error instanceof Error ? error.message : "Semantic search failed.");
    } finally {
      if (aiController.current === controller) {
        aiController.current = null;
        setAiSearching(false);
      }
    }
  }, [query]);

  /** Leaving AI mode, or emptying the box, drops the previous answer so the
   *  filename listing is not sitting behind a stale set of semantic hits. */
  useEffect(() => {
    if (!aiSearch || !query.trim()) {
      aiController.current?.abort();
      setAiHits(null);
      setAiSearching(false);
    }
  }, [aiSearch, query]);

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

  /**
   * Everything else the page needs, in one request.
   *
   * The folder tree, storage totals, Telegram link and session check used to be
   * four calls that queued behind the pooler's single connection, so the page
   * settled at the sum of their latencies. They are answered together now; the
   * individual endpoints remain for the targeted refreshes after a mutation.
   */
  useEffect(() => {
    let cancelled = false;
    apiFetch<{
      user: { name: string } | null;
      folders: DriveFolder[];
      stats: { totalSize: number; count: number };
      link: TelegramLink;
      ai?: boolean;
    }>("/api/overview", { cache: "no-store" })
      .then(data => {
        if (cancelled) return;
        setFolderTree(data.folders);
        setTreeLoaded(true);
        setInsights(prev => ({ ...(prev ?? ({} as Insights)), ...data.stats }));
        setLink(data.link);
        setAiAvailable(Boolean(data.ai));
        setAuthStatus(data.user ? "connected" : "failed");
        try {
          window.localStorage.setItem(`td:${cacheUser}:tree`, JSON.stringify(data.folders));
        } catch {
          /* best-effort */
        }
      })
      .catch(() => {
        if (!cancelled) setAuthStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [cacheUser]);

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

  /**
   * One request after typing stops, not one per keystroke.
   *
   * Clearing the box is exempt: returning to the full listing is a cancellation,
   * the answer is already in the local cache, and making it wait out a delay
   * reads as lag rather than as care.
   */
  useEffect(() => {
    const next = query.trim();
    if (!next) {
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Layout, not effect: this runs after hydration but before the browser paints,
  // so remembered settings are in place for the first frame the user sees rather
  // than snapping into position afterwards. (The pre-paint script in
  // app/layout.tsx covers theme and accent, which are visible sooner still.)
  useIsomorphicLayoutEffect(() => {
    setSidebarWidth(prefs.sidebarWidth);
    setView(prefs.view);
    setSortField(prefs.sortField);
    setSortDir(prefs.sortDir);
    // Preferences load once, from storage, before first paint; re-syncing the
    // session state on every later change would fight the user's per-visit
    // choices in the toolbar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      // Each accent has a separate light variant, so this re-runs with the theme.
      applyAccent(prefs.accent, dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, prefs.accent]);

  // CSS transitions and the two infinite keyframe loops answer to the document,
  // not to framer-motion, so the Settings toggle has to reach them here.
  useEffect(() => {
    applyReducedMotion(prefs.reduceMotion);
  }, [prefs.reduceMotion]);

  useEffect(() => {
    if (!uploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "An upload is still running. Leaving pauses it — it resumes from here when you come back.";
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

  /**
   * Hand the component's knowledge to the manager, which has none of its own.
   *
   * Re-registered whenever the callbacks change identity, so a stored file lands
   * in the folder the user is actually looking at rather than the one they were
   * in when the upload started.
   */
  useEffect(() => {
    uploads.setHooks({ ensureFolderPath, onStored: addFileToState, onIdle: refreshStats });
  }, [ensureFolderPath, addFileToState, refreshStats]);

  // Sessions left behind by a previous visit. Runs once per user, inside the
  // manager, so a remount does not re-read them.
  useEffect(() => {
    uploads.hydrate(cacheUser);
  }, [cacheUser]);

  const startUploads = useCallback(
    (incoming: PickedFile[], destination: string | null = folderId) => {
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
      folderCache.current.clear();
      uploads.add(usable, destination);
      setTrayOpen(true);
    },
    [folderId, maxBytes]
  );

  // ── Downloads ─────────────────────────────────────────────────────────────

  /**
   * Pull a file through the app so the transfer is visible.
   *
   * The bytes are read by the app rather than handed to the browser, which is
   * the only way to know how far along it is. Where the browser can stream to
   * disk it does; otherwise very large files go back to a plain browser download
   * and the row says so instead of inventing a percentage.
   */
  const startDownload = useCallback(async (file: { id: string; originalName: string; size: number }) => {
    const id = `dl-${file.id}-${Date.now()}`;
    const controller = new AbortController();
    downloadControllers.current.set(id, controller);
    const samples: Array<{ t: number; loaded: number }> = [];

    setDownloads(list => [
      ...list,
      {
        id,
        fileId: file.id,
        name: file.originalName,
        size: file.size,
        loaded: 0,
        percent: 0,
        speed: null,
        eta: null,
        status: "downloading"
      }
    ]);
    setTrayOpen(true);

    try {
      const outcome = await downloadWithProgress({
        url: `/api/download/${file.id}`,
        filename: file.originalName,
        sizeHint: file.size,
        signal: controller.signal,
        onProgress: ({ loaded, total }) => {
          const rate = sampleRate(samples, loaded, total || file.size);
          setDownloads(list => list.map(d => (d.id === id ? { ...d, ...rate, size: total || d.size } : d)));
        }
      });

      if (outcome === "cancelled") {
        setDownloads(list => list.filter(d => d.id !== id));
        return;
      }
      if (outcome === "handed-to-browser") {
        setDownloads(list => list.filter(d => d.id !== id));
        toast.info(`"${file.originalName}" is too large to track here — your browser is downloading it.`);
        return;
      }
      setDownloads(list =>
        list.map(d => (d.id === id ? { ...d, loaded: d.size, percent: 100, speed: null, eta: null, status: "done" } : d))
      );
      window.setTimeout(() => setDownloads(list => list.filter(d => d.id !== id)), 4000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed.";
      setDownloads(list => list.map(d => (d.id === id ? { ...d, status: "error", error: message } : d)));
      toast.error(message);
    } finally {
      downloadControllers.current.delete(id);
    }
  }, []);

  /**
   * Download a selection of folders and/or files as one archive.
   *
   * The server streams it and reports the exact size up front, so this behaves
   * like any other download in the panel — percentage, speed and ETA included.
   */
  const startZipDownload = useCallback(
    async (selection: { folderIds?: string[]; fileIds?: string[]; label: string; estimatedBytes?: number }) => {
      // A browser that cannot stream to disk has to assemble the archive in
      // memory, and a multi-gigabyte one would take the tab down with it. The
      // exact size is only known once the response arrives, so the selection's
      // own total stands in — it is within a few hundred bytes per file.
      if (!canStreamToDisk() && (selection.estimatedBytes ?? 0) > MEMORY_DOWNLOAD_LIMIT) {
        toast.error(
          `That is about ${formatBytes(selection.estimatedBytes ?? 0)} — too large for this browser to build an archive in memory. Select fewer items, or use a Chromium browser, which writes the archive straight to disk.`
        );
        return;
      }
      const id = `zip-${Date.now()}`;
      const controller = new AbortController();
      downloadControllers.current.set(id, controller);
      const samples: Array<{ t: number; loaded: number }> = [];

      setDownloads(list => [
        ...list,
        { id, fileId: id, name: `${selection.label}.zip`, size: 0, loaded: 0, percent: 0, speed: null, eta: null, status: "downloading" }
      ]);
      setTrayOpen(true);

      try {
        const outcome = await downloadWithProgress({
          url: "/api/download/zip",
          filename: `${selection.label}.zip`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ folderIds: selection.folderIds, fileIds: selection.fileIds, name: selection.label })
          },
          signal: controller.signal,
          onProgress: ({ loaded, total }) => {
            const rate = sampleRate(samples, loaded, total);
            setDownloads(list => list.map(d => (d.id === id ? { ...d, ...rate, size: total || d.size } : d)));
          }
        });
        if (outcome === "cancelled") {
          setDownloads(list => list.filter(d => d.id !== id));
          return;
        }
        setDownloads(list =>
          list.map(d => (d.id === id ? { ...d, loaded: d.size, percent: 100, speed: null, eta: null, status: "done" } : d))
        );
        window.setTimeout(() => setDownloads(list => list.filter(d => d.id !== id)), 4000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not build the archive.";
        setDownloads(list => list.map(d => (d.id === id ? { ...d, status: "error", error: message } : d)));
        toast.error(message);
      } finally {
        downloadControllers.current.delete(id);
      }
    },
    []
  );

  const cancelDownload = useCallback((id: string) => {
    downloadControllers.current.get(id)?.abort();
    downloadControllers.current.delete(id);
    setDownloads(list => list.filter(d => d.id !== id));
  }, []);

  /** Uploads and downloads in one list, newest activity last. */
  const transfers = useMemo<TransferItem[]>(
    () => [
      ...uploadQueue.map(item => ({ kind: "upload" as const, ...item })),
      ...downloads.map(item => ({ kind: "download" as const, ...item }))
    ],
    [uploadQueue, downloads]
  );

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
      const items = Array.from(e.dataTransfer.items ?? []);
      void rememberDroppedHandles(items, file => resumeKeyFor(file, folderId));
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
  }, [startUploads, folderId]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectedFolders(new Set());
  }, []);

  const toggleFolderSelect = useCallback((id: string) => {
    setSelectedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
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

  // Children of the current folder, straight from the in-memory tree — or, while
  // searching, every folder whose name matches, wherever it sits. The whole tree
  // is already in memory, so matching folders costs nothing and stops a search
  // for a folder's own name from coming back empty.
  const folders = useMemo(() => {
    const matches = debouncedQuery
      ? folderTree.filter(f => f.name.toLowerCase().includes(debouncedQuery.toLowerCase()))
      : folderTree.filter(f => (f.parentId ?? null) === (folderId ?? null));
    return matches.sort((a, b) => a.name.localeCompare(b.name));
  }, [folderTree, folderId, debouncedQuery]);

  // Weighted by bytes, not a mean of per-file percentages — otherwise one tiny
  // finished file next to a 4 GB one would read 50%.
  const overallPercent = useMemo(() => {
    const total = uploadQueue.reduce((sum, item) => sum + item.size, 0);
    if (!total) return 0;
    const loaded = uploadQueue.reduce((sum, item) => sum + (item.status === "done" ? item.size : item.loaded), 0);
    return Math.round((loaded / total) * 100);
  }, [uploadQueue]);

  const browsing = BROWSE_VIEWS.includes(appView);

  /**
   * A search reaches across every folder, so the heading has to say so —
   * otherwise the breadcrumb still reads "Invoices" while the results plainly
   * are not from it.
   *
   * Only the browser views are searchable, so only they may be titled by the
   * search: otherwise switching to Settings with text still in the box left the
   * page headed "Results for …" above something that was not results.
   */
  const heading = !browsing
    ? NAV.find(n => n.view === appView)?.label ?? "My Files"
    : aiSearch && aiAvailable && aiSearchedFor
    ? `Meaning of “${aiSearchedFor}”`
    : debouncedQuery && !aiSearch
    ? `Results for “${debouncedQuery}”`
    : appView === "files"
      ? folderTrail.length
        ? folderTrail[folderTrail.length - 1].name
        : "My Files"
      : NAV.find(n => n.view === appView)?.label ?? "My Files";

  /**
   * Drag the sidebar's edge.
   *
   * Pointer events (not mouse) so a stylus or touch drag works, and capture so
   * the drag survives the pointer leaving the 6 px handle — without that,
   * moving faster than React re-renders drops the grab. The width is written to
   * storage once, on release, rather than on every frame.
   */
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    // Capture keeps the pointer bound to a 6 px strip while the cursor races
    // ahead of it, but it is an enhancement, not the mechanism: the listeners
    // live on the window so the drag still works if capture is unavailable.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* no capture — window listeners below carry the drag */
    }
    setResizing(true);

    const move = (e: PointerEvent) => {
      setSidebarWidth(Math.min(Math.max(e.clientX, SIDEBAR_MIN), SIDEBAR_MAX));
    };
    const end = (e: PointerEvent) => {
      try {
        handle.releasePointerCapture?.(e.pointerId);
      } catch {
        /* it was never captured */
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setResizing(false);
      setSidebarWidth(width => {
        setPreference("sidebarWidth", width);
        return width;
      });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);

  /** Back to the root of My Files, from wherever the app currently is. */
  const goHome = useCallback(() => {
    setAppView("files");
    setFolderId(null);
    setFolderTrail([]);
    setSidebarOpen(false);
    window.history.pushState(null, "", "?");
  }, []);

  return (
    // The sidebar width is one variable, read by the sidebar, the main column
    // and the bulk bar, so a drag moves all three together.
    <div className="app-bg relative min-h-[100dvh]" style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}>
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
            {...fadeIn(reduceMotion)}
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
          "frost fixed inset-y-0 left-0 z-50 flex w-[82vw] flex-col px-4 py-5 lg:translate-x-0",
          // The transition is dropped mid-drag: animating width while the
          // pointer sets it makes the edge lag behind the cursor.
          !resizing && "transition-transform duration-300",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{
          borderRight: "1px solid var(--border-dim)",
          willChange: "transform",
          maxWidth: "var(--sidebar-w)"
        }}
      >
        <div className="flex items-center justify-between">
          <button
            onClick={goHome}
            className="flex min-w-0 items-center gap-2.5 rounded-lg text-left transition hover:opacity-80"
            aria-label="Go to My Files"
            title="My Files"
          >
            <Logo size={30} />
            <div className="min-w-0">
              <p className="display truncate text-[15px] leading-none">TeleDrive</p>
              <p className="eyebrow mt-1">Personal cloud</p>
            </div>
          </button>
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

        <TransferPanel
          transfers={transfers}
          open={trayOpen}
          onToggle={() => setTrayOpen(o => !o)}
          onCancelUpload={id => uploads.cancel(id)}
          onCancelAll={() => {
            uploads.cancelAll();
            downloadControllers.current.forEach(c => c.abort());
            downloadControllers.current.clear();
            setDownloads([]);
          }}
          onPauseUpload={id => uploads.pause(id)}
          onResumeUpload={id => uploads.resume(id)}
          onPauseAll={() => uploads.pauseAll()}
          onResumeAll={() => uploads.resumeAll()}
          onRetryUpload={id => uploads.retry(id)}
          onCancelDownload={cancelDownload}
          onRetryDownload={item => {
            setDownloads(list => list.filter(d => d.id !== item.id));
            // A zip is rebuilt from its own row: the selection that produced it
            // is long gone, so the file id is the only handle left.
            if (item.id.startsWith("zip-")) {
              toast.info("Select the folders again to rebuild that archive.");
              return;
            }
            void startDownload({ id: item.fileId, originalName: item.name, size: item.size });
          }}
          onDismiss={id => {
            uploads.dismiss(id);
            setDownloads(list => list.filter(d => d.id !== id));
          }}
        />

        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto pb-3">
          {NAV.map(({ icon: Icon, label, view: navView }) => (
            <button key={navView} onClick={() => selectView(navView)} className="nav-item" data-active={appView === navView}>
              {appView === navView ? (
                <motion.span
                  layoutId="nav-rail"
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full"
                  style={{ background: "var(--accent-grad)" }}
                  transition={SPRING}
                />
              ) : null}
              <Icon className="h-4 w-4 shrink-0" style={{ color: appView === navView ? "var(--accent)" : undefined }} />
              {label}
            </button>
          ))}
        </nav>

        <div className="rounded-xl p-3.5" style={{ background: "var(--surface)", border: "1px solid var(--border-dim)" }}>
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => selectView("insights")}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left transition hover:opacity-80"
              aria-label="Your storage and account stats"
              title="Storage and account stats"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-bold" style={{ background: "var(--accent-grad)", color: "#04070c" }}>
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="t-sm block truncate font-semibold" style={{ color: "var(--text-1)" }}>{user.name}</span>
                <span className="mono block truncate" style={{ color: "var(--text-3)" }}>{user.username ? `@${user.username}` : "Telegram"}</span>
              </span>
            </button>
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

        {/* Resize handle — desktop only, where the sidebar is a fixed column.
            Focusable and arrow-key operable so it is not mouse-only. */}
        <div
          onPointerDown={startResize}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_DEFAULT);
            setPreference("sidebarWidth", SIDEBAR_DEFAULT);
          }}
          onKeyDown={e => {
            const step = e.shiftKey ? 32 : 8;
            const delta = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
            if (!delta) return;
            e.preventDefault();
            setSidebarWidth(width => {
              const next = Math.min(Math.max(width + delta, SIDEBAR_MIN), SIDEBAR_MAX);
              setPreference("sidebarWidth", next);
              return next;
            });
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          tabIndex={0}
          className="absolute inset-y-0 right-0 hidden w-1.5 cursor-col-resize lg:block"
          style={{ background: resizing ? "var(--accent)" : "transparent", touchAction: "none" }}
        />
      </aside>

      {/* ── Main ── */}
      <div className="lg:pl-[var(--sidebar-w)]">
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
                onKeyDown={e => {
                  if (e.key === "Enter" && aiSearch && aiAvailable) {
                    e.preventDefault();
                    void runAiSearch();
                  }
                }}
                placeholder={aiSearch && aiAvailable ? "Describe it — press Enter" : "Search files…"}
                aria-label={aiSearch && aiAvailable ? "Search by meaning" : "Search files"}
                className={cn("field pl-9", aiAvailable && "pr-16")}
                style={{ height: 38, ...(aiSearch && aiAvailable ? { borderColor: "var(--accent)" } : {}) }}
              />
              {aiAvailable ? (
                <AiSearchToggle
                  on={aiSearch}
                  onToggle={() => {
                    setAiSearch(on => !on);
                    // Focus stays in the box: the toggle is a change of mode for
                    // what is already typed, not a separate destination.
                    (document.getElementById("drive-search") as HTMLInputElement | null)?.focus();
                  }}
                />
              ) : null}
            </div>

            {uploading ? (
              <div className="hidden items-center gap-2 sm:flex">
                <div className="progress-track h-1.5 w-16 overflow-hidden rounded-full" style={{ background: "var(--surface)" }}>
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
              {browsing && appView === "files" && !debouncedQuery ? (
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
            <motion.div initial={fadeUp(reduceMotion).initial} animate={{ opacity: 1, y: 0 }} transition={transition}>
              {appView === "settings" ? (
                <SettingsPanel link={link} onLinkChanged={refreshLink} />
              ) : appView === "about" ? (
                <AboutPanel maxBytes={maxBytes} />
              ) : appView === "shared" ? (
                <SharesPanel />
              ) : appView === "insights" ? (
                <InsightsPanel
                  insights={insights}
                  user={user}
                  onOpenFile={id => {
                    const file = files.find(f => f.id === id);
                    if (file) setPreviewFile(file);
                    // Insights lists the largest files across the whole drive,
                    // most of which are not in the current folder's page.
                    else browserDownload(`/api/download/${id}`);
                  }}
                />
              ) : aiSearch && aiAvailable ? (
                /* Semantic results take the place of the grid rather than
                   sitting beside it: they are a different answer to the same
                   question, and showing both invites reading one as the other. */
                <AiSearchResults
                  hits={aiHits}
                  searching={aiSearching}
                  query={aiSearchedFor}
                  onOpen={file => setPreviewFile(file)}
                  onAsk={file => setAskAi({ file })}
                />
              ) : (
                <>
                  {/* Folders — only in the browsable root view. Favourites and
                      Trash list files across folders, and the folder state may
                      still hold the previous view's rows while it refetches. */}
                  {appView === "files" && !treeLoaded && !folders.length ? (
                    <SkeletonFolders />
                  ) : null}
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
                            onClick={() => (selectedFolders.size || selected.size ? toggleFolderSelect(folder.id) : enterFolder(folder))}
                            // Warm the listing before the click lands, so the
                            // folder opens against a populated cache.
                            onMouseEnter={() => prefetchFolder(folder.id)}
                            onFocus={() => prefetchFolder(folder.id)}
                            onTouchStart={() => prefetchFolder(folder.id)}
                          >
                            <span
                              onClick={e => {
                                e.stopPropagation();
                                toggleFolderSelect(folder.id);
                              }}
                              role="checkbox"
                              aria-checked={selectedFolders.has(folder.id)}
                              aria-label={`Select ${folder.name}`}
                              tabIndex={0}
                              onKeyDown={e => {
                                if (e.key !== " " && e.key !== "Enter") return;
                                e.preventDefault();
                                e.stopPropagation();
                                toggleFolderSelect(folder.id);
                              }}
                              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg transition"
                              style={{
                                background: selectedFolders.has(folder.id) ? "var(--accent)" : "rgba(129,140,248,0.12)",
                                border: `1px solid ${selectedFolders.has(folder.id) ? "var(--accent)" : "rgba(129,140,248,0.24)"}`
                              }}
                            >
                              {selectedFolders.has(folder.id) ? (
                                <Check className="h-4 w-4" style={{ color: "#04070c" }} />
                              ) : (
                                <FolderIcon className="h-4 w-4" style={{ color: "var(--accent-2)" }} />
                              )}
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
                                <DropdownMenu.Item
                                  onSelect={() =>
                                    void startZipDownload({
                                      folderIds: [folder.id],
                                      label: folder.name,
                                      estimatedBytes: folder.size ?? 0
                                    })
                                  }
                                  className="menu-item"
                                >
                                  <Download className="h-4 w-4" style={{ color: "var(--accent)" }} /> Download as zip
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
                            selectionActive={selected.size + selectedFolders.size > 0}
                            mtprotoUserId={link?.telegramUserId ?? null}
                            actions={{
                              onPreview: () => setPreviewFile(file),
                              onDownload: () => void startDownload(file),
                              onShare: () => setShareTarget({ fileId: file.id, name: file.originalName }),
                              onDelete: () => confirmTrash([file.id]),
                              onFavorite: () => toggleFavorite(file.id),
                              onRestore: () => restoreFile(file.id),
                              onRename: () => setRenameFile({ id: file.id, value: file.originalName }),
                              onMove: () => setMoveModal({ ids: selected.has(file.id) ? [...selected] : [file.id] }),
                              onProperties: () => setPropsTarget({ kind: "file", file }),
                              onToggleSelect: () => toggleSelect(file.id),
                              // Undefined when AI is off, which is what removes
                              // the submenu rather than greying it out.
                              onAskAi: aiAvailable ? action => setAskAi({ file, action }) : undefined
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
        {selected.size + selectedFolders.size ? (
          <motion.div
            {...riseFromBottom(reduceMotion)}
            className="safe-bottom fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 lg:left-[var(--sidebar-w)]"
          >
            <div
              className="no-scrollbar mx-auto flex max-w-fit items-center gap-1.5 overflow-x-auto rounded-2xl px-2.5 py-2"
              style={{ background: "var(--bg-2)", border: "1px solid var(--border-med)", boxShadow: "var(--shadow-lg)" }}
            >
              <span className="t-sm shrink-0 px-1.5 font-bold" style={{ color: "var(--accent)" }}>
                {selected.size + selectedFolders.size}
              </span>
              {selected.size < files.length ? (
                <button onClick={selectAll} className="btn btn-ghost shrink-0">
                  <Check className="h-4 w-4" />
                  <span className="hidden sm:inline">All ({files.length})</span>
                </button>
              ) : null}
              <button
                onClick={() => {
                  // One file on its own arrives as itself; anything more — and
                  // any folder at all — comes back as a single archive, which is
                  // the point of being able to pick several.
                  if (selected.size === 1 && !selectedFolders.size) {
                    const only = files.find(f => f.id === [...selected][0]);
                    if (only) {
                      void startDownload(only);
                      clearSelection();
                      return;
                    }
                  }
                  const label =
                    selectedFolders.size === 1 && !selected.size
                      ? folderTree.find(f => f.id === [...selectedFolders][0])?.name || "teledrive"
                      : `teledrive-${selected.size + selectedFolders.size}-items`;
                  const estimatedBytes =
                    [...selectedFolders].reduce((sum, id) => sum + (folderTree.find(f => f.id === id)?.size ?? 0), 0) +
                    [...selected].reduce((sum, id) => sum + (files.find(f => f.id === id)?.size ?? 0), 0);
                  void startZipDownload({
                    folderIds: [...selectedFolders],
                    fileIds: [...selected],
                    label,
                    estimatedBytes
                  });
                  clearSelection();
                }}
                className="btn btn-ghost shrink-0"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download</span>
              </button>
              {appView !== "trash" && selected.size ? (
                <button onClick={() => setMoveModal({ ids: [...selected] })} className="btn btn-ghost shrink-0">
                  <FolderInput className="h-4 w-4" />
                  <span className="hidden sm:inline">Move</span>
                </button>
              ) : selected.size ? (
                <button onClick={() => bulkAction("restore", [...selected])} className="btn btn-ghost shrink-0" style={{ color: "var(--emerald)" }}>
                  <RotateCw className="h-4 w-4" />
                  <span className="hidden sm:inline">Restore</span>
                </button>
              ) : null}
              {appView !== "trash" && selected.size ? (
                <button onClick={() => bulkAction("favorite", [...selected])} className="btn btn-ghost shrink-0" style={{ color: "var(--amber)" }}>
                  <Star className="h-4 w-4" />
                  <span className="hidden sm:inline">Favourite</span>
                </button>
              ) : null}
              {selected.size ? (
                <button onClick={() => confirmTrash([...selected])} className="btn btn-danger shrink-0">
                  <Trash2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Delete</span>
                </button>
              ) : null}
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
            {...fadeIn(reduceMotion)}
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
        {askAi && aiAvailable ? (
          <AskAiPanel file={askAi.file} initialAction={askAi.action} onClose={() => setAskAi(null)} />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {previewFile ? (
          <Lightbox
            file={previewFile}
            allFiles={files}
            onClose={() => setPreviewFile(null)}
            onNavigate={setPreviewFile}
            onDownload={target => void startDownload(target)}
          />
        ) : null}
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
          <MoveModal
            count={moveModal.ids.length}
            currentFolderId={folderId}
            folders={folderTree}
            onMove={target => moveFilesTo(moveModal.ids, target)}
            onClose={() => setMoveModal(null)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>{propsTarget ? <PropertiesModal target={propsTarget} onClose={() => setPropsTarget(null)} /> : null}</AnimatePresence>
      <AnimatePresence>
        {shareTarget ? <ShareModal targetName={shareTarget.name} onCreate={createShare} onClose={() => setShareTarget(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

/** Placeholder folder cards, sized like the real ones so nothing shifts. */
function SkeletonFolders() {
  return (
    <div className="mb-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card flex items-center gap-2.5 p-3">
          <div className="skeleton h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-1/2" />
            <div className="skeleton h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The listing's placeholder, built to the tile's exact height.
 *
 * Including the action row matters: a real grid tile ends with a 36px row of
 * buttons under a 12px margin, and a skeleton without it was 48px shorter per
 * row. Every tile then jumped downwards the moment the files arrived, which is
 * the layout shift a skeleton exists to prevent.
 */
function SkeletonGrid({ view }: { view: "grid" | "list" }) {
  return (
    <div className={view === "grid" ? "grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "space-y-2"}>
      {Array.from({ length: view === "grid" ? 10 : 6 }).map((_, i) => (
        <div key={i} className={cn("card p-3", view === "list" && "flex items-center gap-3")}>
          <div className={cn("skeleton", view === "grid" ? "mb-3 aspect-[4/3] w-full" : "h-11 w-11 shrink-0")} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3.5 w-3/5" />
            <div className="skeleton h-3 w-2/5" />
          </div>
          <div className={cn("flex items-center gap-1.5", view === "grid" ? "mt-3" : "ml-auto")}>
            {view === "grid" ? (
              <>
                <div className="skeleton h-9 flex-1 rounded-lg" />
                <div className="skeleton h-9 flex-1 rounded-lg" />
              </>
            ) : null}
            <div className="skeleton h-9 w-9 shrink-0 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}
