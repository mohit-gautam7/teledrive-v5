/**
 * Files handed to the app by the Android share sheet.
 *
 * The share target is a POST, and a page cannot read that body — only the
 * service worker can. So the worker parks each file in a cache and redirects
 * here; this drains it.
 *
 * The redirect is sent before the parking finishes (the share sheet stays on
 * screen until the worker responds, so it must respond at once), which means
 * this page can arrive before, during or after the files land. Hence the poll:
 * wait for the first file, then give the rest one more tick to appear.
 */

const SHARED_CACHE = "teledrive-shared-intake";
const POLL_MS = 150;
const SETTLE_MS = 350;
const GIVE_UP_MS = 8_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function drainOnce(): Promise<File[]> {
  if (typeof caches === "undefined") return [];
  if (!(await caches.has(SHARED_CACHE))) return [];

  const cache = await caches.open(SHARED_CACHE);
  const keys = await cache.keys();
  if (!keys.length) return [];

  const files: File[] = [];
  for (const key of keys) {
    const res = await cache.match(key);
    // Delete first: a file that fails to reconstruct must not be retried on
    // every visit to /drive for the rest of time.
    await cache.delete(key);
    if (!res) continue;

    const name = decodeURIComponent(res.headers.get("x-filename") || "shared-file");
    const type = res.headers.get("content-type") || "application/octet-stream";
    const blob = await res.blob();
    if (blob.size > 0) files.push(new File([blob], name, { type }));
  }
  return files;
}

/**
 * Collect everything the share sheet sent. Resolves with an empty array when
 * nothing was shared, which is the normal case for an ordinary visit.
 */
export async function takeSharedFiles(): Promise<File[]> {
  const deadline = Date.now() + GIVE_UP_MS;
  const collected: File[] = [];

  while (Date.now() < deadline) {
    const batch = await drainOnce();
    if (batch.length) {
      collected.push(...batch);
      // One more pass, in case the worker was still writing when we looked.
      await sleep(SETTLE_MS);
      collected.push(...(await drainOnce()));
      return collected;
    }
    await sleep(POLL_MS);
  }
  return collected;
}

/**
 * Drop every cache holding this account's data. Called on sign-out: the Cache
 * API is scoped to the origin, not to the signed-in user, and this app has
 * more than one account.
 */
export function clearPrivateCaches(): void {
  navigator.serviceWorker?.controller?.postMessage("clear-private");
}
