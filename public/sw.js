/*
 * TeleDrive service worker.
 *
 * The previous version opened a cache, put exactly one thing in it
 * (/offline.html), and then answered every non-navigation request with
 * `caches.match(req) || fetch(req)`. Since nothing ever called `cache.put`,
 * that lookup could only ever miss, so it was a no-op wrapped around a cache
 * miss on every single request — and the one thing it did do, serving a stale
 * offline page after a dev-server restart, was a bug rather than a feature.
 *
 * This version is explicit about which requests get which strategy, because
 * for this app the wrong answer is not "slow", it is "someone else's file".
 *
 *   shell   cache-first   immutable build output, icons, the manifest
 *   thumbs  cache-first   /api/preview/<id>?thumb=1 — capped, LRU-ish
 *   data    SWR           the listing endpoints, so the grid paints offline
 *   never   network-only  auth, upload, download, stream, share links, cron
 *
 * Everything cached here is private to the signed-in user, so the caches are
 * dropped on sign-out (see the 'clear-private' message below). The Cache API
 * is per-origin, not per-account, and this app has more than one account.
 */

const VERSION = 'v5';
const SHELL = `teledrive-shell-${VERSION}`;
const THUMBS = `teledrive-thumbs-${VERSION}`;
const DATA = `teledrive-data-${VERSION}`;
const SHARED = 'teledrive-shared-intake';

const OFFLINE = '/offline.html';
const PRECACHE = [OFFLINE, '/manifest.json', '/icon-192.png', '/icon-512.png'];

/** Thumbnails are ~10-30 KB each; 600 is a few folders' worth, not a disk. */
const THUMB_LIMIT = 600;

/** Caches holding user data, dropped on sign-out. SHELL is public build output. */
const PRIVATE_CACHES = [THUMBS, DATA, SHARED];

/* ── Install / activate ──────────────────────────────────────────────────── */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, THUMBS, DATA, SHARED]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  // Sign-out: drop everything that belonged to that account. Keep SHELL — it
  // is the same build output for everyone and re-fetching it only costs time.
  if (event.data === 'clear-private') {
    event.waitUntil(Promise.all(PRIVATE_CACHES.map((c) => caches.delete(c))));
  }
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* ── Routing ─────────────────────────────────────────────────────────────── */

/** Requests that must never be served from, or written to, a cache. */
function isNeverCached(path) {
  return (
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/upload') ||
    path.startsWith('/api/download') ||
    path.startsWith('/api/stream/') ||
    path.startsWith('/api/public/') ||
    path.startsWith('/api/bot/') ||
    path.startsWith('/api/cron/') ||
    path.startsWith('/api/share') ||
    path.startsWith('/api/ai/')
  );
}

/**
 * Dev servers serve `/_next/static/*` at *stable* paths — no content hash —
 * and rebuild what is behind them on every edit. Pinning those is how you end
 * up staring at a page that is three edits old wondering why your change did
 * nothing. In a production build the same paths are content-hashed, so a new
 * build is a new URL and cache-first is exactly right.
 */
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

/** Build output and icons: content-hashed or rarely changed, safe to pin. */
function isShellAsset(path) {
  if (path.startsWith('/_next/static/')) return !DEV;
  return (
    path === '/manifest.json' ||
    path === '/offline.html' ||
    /^\/(icon|apple-touch-icon)[\w.-]*\.(png|svg|ico)$/.test(path)
  );
}

/** A thumbnail — small, immutable, and the thing the grid asks for in bulk. */
function isThumb(url) {
  return url.pathname.startsWith('/api/preview/') && url.searchParams.get('thumb') === '1';
}

/** Listing endpoints: worth showing stale, worth refreshing behind the scenes. */
function isListing(path) {
  return (
    path === '/api/files' ||
    path === '/api/folders' ||
    path === '/api/overview' ||
    path === '/api/files/stats'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // The Android share sheet POSTs here. Must be checked before the GET-only
  // guard below, and before anything touches the network.
  if (request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (isNeverCached(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (isShellAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  if (isThumb(url)) {
    event.respondWith(cacheFirstThumb(request));
    return;
  }
  if (isListing(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Anything else: straight to the network, as if no worker were installed.
});

/* ── Strategies ──────────────────────────────────────────────────────────── */

async function networkFirstPage(request) {
  try {
    const res = await fetch(request);
    // Keep the last good copy of the page so an offline reload gets the real
    // app, which then hydrates from the cached listings, instead of the
    // generic offline card. /drive renders the signed-in user's name and
    // avatar server-side, so this is private data and belongs in DATA, which
    // is dropped on sign-out — never in SHELL.
    //
    // `redirected` matters: signed out, /drive 302s to /, and fetch follows it.
    // Caching that under the /drive key would pin the login page in place for
    // a user who is perfectly well signed in.
    if (res.ok && !res.redirected) {
      const cache = await caches.open(DATA);
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    // Prefer the real page this user last saw over a generic offline card.
    return (await caches.match(request)) || (await caches.match(OFFLINE)) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function cacheFirstThumb(request) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(request);
  if (hit) return hit;

  const res = await fetch(request);
  // 401/403 means the session expired or the file belongs to someone else.
  // Caching that would pin the error in place long after signing back in.
  if (res.ok) {
    cache.put(request, res.clone()).catch(() => {});
    trimThumbs();
  }
  return res;
}

let trimming = false;
async function trimThumbs() {
  if (trimming) return;
  trimming = true;
  try {
    const cache = await caches.open(THUMBS);
    const keys = await cache.keys();
    // Cache.keys() returns insertion order, so the front is the oldest. Not a
    // true LRU — a re-read does not promote an entry — but it costs one pass
    // instead of a side index, and for a scrolling grid the difference is noise.
    const excess = keys.length - THUMB_LIMIT;
    if (excess > 0) await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  } catch {
    /* a full or evicted cache is not worth failing a request over */
  } finally {
    trimming = false;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(request);

  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (hit) {
    // Refresh in the background; the caller already has something to render.
    void fresh;
    return hit;
  }
  return (await fresh) || Response.error();
}

/* ── Share target ────────────────────────────────────────────────────────── */

/**
 * Android hands shared files to a POST, not to a page. A page cannot read that
 * body, so the worker takes it, parks each file in a cache, and bounces the
 * browser to /drive, which drains the cache and queues the uploads.
 *
 * The redirect has to happen immediately — the share sheet stays on screen
 * until this responds — so the parking happens in waitUntil, and /drive waits
 * for it by polling briefly rather than by racing it.
 */
async function handleShareTarget(event) {
  event.waitUntil(
    (async () => {
      try {
        const form = await event.request.formData();
        const files = form.getAll('files').filter((f) => f instanceof File && f.size > 0);
        if (!files.length) return;

        const cache = await caches.open(SHARED);
        await Promise.all(
          files.map((file, i) =>
            cache.put(
              `/__shared/${Date.now()}-${i}`,
              new Response(file, {
                headers: {
                  'content-type': file.type || 'application/octet-stream',
                  'x-filename': encodeURIComponent(file.name || `shared-${i}`)
                }
              })
            )
          )
        );
      } catch {
        /* nothing parked — /drive simply finds an empty cache and says so */
      }
    })()
  );

  return Response.redirect('/drive?shared=1', 303);
}
