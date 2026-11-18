/**
 * Play videos straight from the user's own Telegram, on this device.
 *
 * The file server can stream any file, but on Render's free plan it decrypts
 * MTProto at about 1 MB/s (0.15 CPU), so a film took most of a minute to start.
 * This device already holds its own Telegram session (lib/direct-upload) and
 * has far more CPU, so it should do the reading.
 *
 * A <video> element only speaks HTTP, though, and seeking needs Range
 * requests. So the player is pointed at `/__direct/<messageId>`, which the
 * service worker (public/sw.js) intercepts: for each Range it asks this page,
 * over a MessageChannel, for those bytes, and the page reads them from
 * Telegram with readDirectRange. Nothing touches the file server.
 *
 * Any device works the same way once it is connected to Telegram (that happens
 * automatically after a Telegram sign-in, or under Settings → Direct upload).
 * A device that is not connected, or has no service worker yet, simply keeps
 * using the file server.
 */

type RangeRequest = { type: "td-direct-range"; messageId: string; start: number; end: number };

let bridgeUser: string | null = null;
let installed = false;

/** Answer the service worker's byte requests for `user`. Safe to call repeatedly. */
export function installDirectStreamBridge(user: string) {
  bridgeUser = user;
  if (installed || typeof navigator === "undefined" || !navigator.serviceWorker) return;
  installed = true;
  navigator.serviceWorker.addEventListener("message", event => {
    const data = event.data as RangeRequest | undefined;
    const port = event.ports?.[0];
    if (!port || data?.type !== "td-direct-range") return;
    const user = bridgeUser;
    void (async () => {
      try {
        if (!user) throw new Error("No signed-in user on this page.");
        const { readDirectRange } = await import("@/lib/direct-upload");
        const bytes = await readDirectRange(user, Number(data.messageId), data.start, data.end);
        // Copy into an exact-size buffer so it can be transferred, not cloned.
        const out = bytes.slice();
        port.postMessage({ ok: true, bytes: out.buffer }, [out.buffer]);
      } catch (error) {
        port.postMessage({ ok: false, error: (error as Error)?.message || "Telegram read failed" });
      }
    })();
  });
}

/**
 * A playable URL served from Telegram on this device, or null when this device
 * cannot (not connected to Telegram, or no active service worker yet).
 */
export async function directStreamUrl(user: string, file: { telegramMessageId?: string | number | null; size: number; mimeType: string }): Promise<string | null> {
  if (!file.telegramMessageId || typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return null;
  const { browserLinked } = await import("@/lib/direct-upload");
  if (!browserLinked(user)) return null;
  installDirectStreamBridge(user);
  return `/__direct/${file.telegramMessageId}?size=${file.size}&type=${encodeURIComponent(file.mimeType || "application/octet-stream")}`;
}
