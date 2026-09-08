/**
 * Where the heavy bytes go.
 *
 * TeleDrive proxies every stored byte through its own server — it never hands a
 * Telegram URL to the browser, because that URL embeds the bot token. That makes
 * bandwidth, not CPU, the limit that actually binds, and Vercel's Hobby plan
 * meters 100 GB a month against it. Fifty downloads of a 2 GB file is the whole
 * allowance.
 *
 * So the app can be split across two origins: the Next.js app and its light JSON
 * routes stay on Vercel, and the routes that actually move file bytes are called
 * directly on a second deployment of the *same* application — Render, which has
 * no request-body cap and no 60 s function ceiling. Both deployments share one
 * DATABASE_URL and one JWT_SECRET, so they are the same drive; only the traffic
 * is split. Nothing here proxies: a proxied byte still crosses Vercel and still
 * counts, which would defeat the point.
 *
 * Set NEXT_PUBLIC_FILE_ORIGIN to enable it. Unset — local development, and a
 * single-origin deployment on either platform — every helper here returns the
 * relative path it was given and the app behaves exactly as it did before.
 */

const RAW = process.env.NEXT_PUBLIC_FILE_ORIGIN ?? "";

/** The absolute origin heavy requests go to, or "" for same-origin. */
export const FILE_ORIGIN = RAW.trim().replace(/\/+$/, "");

/**
 * Paths whose responses or request bodies are large enough to be worth moving.
 *
 * `/api/upload/check` is deliberately *not* here. It is a few hundred bytes of
 * JSON, and on Render's free tier a sleeping service takes the better part of a
 * minute to wake — asking it this question would stall the duplicate prompt
 * behind a cold start every time. Left on the primary origin, the prompt opens
 * immediately and the wake happens while the user is reading it.
 */
const HEAVY = [
  /^\/api\/upload(\/(?!check)|$)/,
  /^\/api\/download(\/|$)/,
  /^\/api\/stream(\/|$)/,
  /^\/api\/preview(\/|$)/,
  /^\/api\/public\/(download|stream)(\/|$)/
];

export function isHeavyPath(path: string) {
  return HEAVY.some(pattern => pattern.test(path));
}

/**
 * The URL to actually call for an app path.
 *
 * Same-origin relative paths for everything light, and for everything at all
 * when FILE_ORIGIN is unset — which keeps `pnpm dev` a single origin with no
 * CORS and no tokens in play.
 */
export function apiUrl(path: string) {
  if (!FILE_ORIGIN || typeof path !== "string" || !path.startsWith("/")) return path;
  return isHeavyPath(path) ? `${FILE_ORIGIN}${path}` : path;
}

// ── Cross-origin credentials ─────────────────────────────────────────────────

/**
 * The session lives in an httpOnly, SameSite=Lax cookie, which is exactly right
 * and exactly unusable across origins: the browser will not send it to the file
 * origin, and script cannot read it to forward it. So the primary origin mints a
 * second, narrower credential — a JWT signed with the same JWT_SECRET, scoped to
 * file routes and valid for an hour — and the client presents that instead.
 *
 * It is deliberately not a session: lib/auth refuses a file-scoped token
 * anywhere it would act as one, and refuses a session token presented as a
 * bearer. A token that leaks buys an hour of access to file bytes, not an
 * account.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000;
/** Renewed early, so a long upload never crosses the expiry mid-flight. */
const RENEW_BEFORE_MS = 10 * 60 * 1000;

let token: string | null = null;
let issuedAt = 0;
let inFlight: Promise<string | null> | null = null;

const listeners = new Set<() => void>();
let version = 0;

function announce() {
  version++;
  for (const listener of listeners) listener();
}

/** Subscribe to token changes — for `useSyncExternalStore`, so an `<img>` whose
 *  src carries the token re-renders once the token is actually there. */
export function subscribeFileAuth(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function fileAuthVersion() {
  return version;
}

function fresh() {
  return token && Date.now() - issuedAt < TOKEN_TTL_MS - RENEW_BEFORE_MS ? token : null;
}

/**
 * A usable file token, fetching one if needed.
 *
 * Returns null when the app is single-origin (nothing to authenticate across)
 * or when the mint fails — callers fall back to a plain relative URL, which is
 * correct on a single origin and fails loudly rather than silently on a split
 * one.
 */
export async function fileToken(): Promise<string | null> {
  if (!FILE_ORIGIN) return null;
  const current = fresh();
  if (current) return current;
  // One mint at a time: a folder drop starts dozens of uploads at once and every
  // one of them would otherwise ask for its own token in the same tick.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch("/api/auth/file-token", { method: "POST" });
      if (!response.ok) return null;
      const body = (await response.json()) as { token?: string };
      if (!body.token) return null;
      token = body.token;
      issuedAt = Date.now();
      announce();
      return token;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Fetch a token now, so the first tile render already has one. */
export function primeFileToken() {
  return fileToken();
}

/** Headers to add to a cross-origin call. Empty object on a single origin. */
export async function fileAuthHeaders(): Promise<Record<string, string>> {
  const value = await fileToken();
  return value ? { authorization: `Bearer ${value}` } : {};
}

/**
 * A URL for an `<img>`, `<video>` or a browser-driven download.
 *
 * These cannot carry an Authorization header — the browser makes the request,
 * not the app — so the token rides in the query string instead. That is the
 * trade the tag forces: a short-lived, file-scoped token that may end up in a
 * server log, rather than a session cookie that must not.
 *
 * Synchronous on purpose, because it is called during render. If the token has
 * not arrived yet it returns the relative path; `subscribeFileAuth` is what
 * re-renders the tag once it has.
 */
export function assetUrl(path: string) {
  const url = apiUrl(path);
  if (url === path) return url;
  const current = fresh() ?? token;
  if (!current) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(current)}`;
}
