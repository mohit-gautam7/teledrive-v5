/**
 * Upload straight from this browser to Telegram, with nothing in between.
 *
 * The relay path sends every byte to this app's host, which forwards it to
 * Telegram: the file crosses the network twice and the host pays for both
 * legs. On Vercel's free plan that is the 100 GB/month that made a bulk
 * import impossible and put a ceiling on phone backup. MTProto is a client
 * protocol, so the page can do that upload itself and tell the host only
 * where the file landed — about a kilobyte instead of the whole file.
 *
 * ── Why this browser has its own Telegram session ──────────────────────────
 *
 * The obvious design is to hand the browser the session the server already
 * holds. That was tried, and Telegram refuses it: an auth key used from two
 * places at once is answered with AUTH_KEY_DUPLICATED and the session is
 * killed — taking the server's uploads down with it. One key, one client.
 *
 * So this browser authorises itself, once, with its own QR scan, and gets a
 * session of its own. It costs a scan, and it is better in every other way:
 * the server's credential never leaves the server, and the browser's key is
 * an ordinary Telegram device the user can see and revoke under
 * Settings → Devices, exactly like Telegram Web.
 *
 * ── Where the key lives ────────────────────────────────────────────────────
 *
 * In this browser's localStorage, under this origin, keyed by TeleDrive user.
 * It has to survive a reload or every visit would mean another scan. That is
 * a real exposure and the UI says so plainly: the key reaches as far as the
 * user's whole Telegram account, not just their TeleDrive files. Signing out
 * of TeleDrive, or switching this off, logs the session out at Telegram's end
 * rather than merely forgetting it.
 */

import type { TelegramClient } from "telegram";

export type DirectConfig = { enabled: boolean; apiId: number; apiHash: string };

/** Parallel part uploads. GramJS calls anything above 16 unstable, and a phone
 *  on mobile data is happier well below that; the gain flattens early. */
const WORKERS = 4;

/** Telegram allows at most 4000 parts and GramJS sends 512 KiB ones — the same
 *  2 GB ceiling the relay path has. */
const MAX_DIRECT_BYTES = 4000 * 512 * 1024;

/** Drop the socket after a quiet spell rather than holding one open all day. */
const IDLE_DISCONNECT_MS = 2 * 60_000;

const sessionKey = (user: string) => `td:${user}:tg-session:v1`;

let configPromise: Promise<DirectConfig | null> | null = null;
let clientPromise: Promise<TelegramClient> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/* ── Stored session ────────────────────────────────────────────────────────── */

export function storedSession(user: string): string | null {
  try {
    return window.localStorage.getItem(sessionKey(user)) || null;
  } catch {
    // Private mode, blocked site data: treat as "not linked" rather than throw.
    return null;
  }
}

function rememberSession(user: string, session: string) {
  try {
    window.localStorage.setItem(sessionKey(user), session);
  } catch {
    /* nothing to do — the next visit simply asks for another scan */
  }
}

function forgetStoredSession(user: string) {
  try {
    window.localStorage.removeItem(sessionKey(user));
  } catch {
    /* already gone as far as anyone can tell */
  }
}

/** True when this browser holds a Telegram session of its own. */
export function browserLinked(user: string): boolean {
  return Boolean(storedSession(user));
}

/* ── Server-side switch and app identifiers ────────────────────────────────── */

/**
 * Whether the account has direct upload switched on, plus the api_id/api_hash
 * a client needs. Memoised per tab, negative answers included, so a queue of
 * files does not generate a request each.
 *
 * These identify the application, not the user. They are kept behind the
 * session cookie rather than inlined into the public bundle so they reach
 * signed-in callers only — every browser MTProto client has to expose them
 * somewhere, and this is the narrowest somewhere.
 */
export function directConfig(): Promise<DirectConfig | null> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const res = await fetch("/api/telegram/direct-session", {
          credentials: "same-origin",
          cache: "no-store"
        });
        if (!res.ok) return null;
        const body = (await res.json()) as Partial<DirectConfig>;
        if (!body?.enabled || !body.apiId || !body.apiHash) return null;
        return { enabled: true, apiId: body.apiId, apiHash: body.apiHash };
      } catch {
        return null;
      }
    })();
  }
  return configPromise;
}

/** Forget what this tab is holding, without touching Telegram or storage. */
export function forgetDirectSession() {
  configPromise = null;
  const pending = clientPromise;
  clientPromise = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  void pending?.then(client => client.disconnect()).catch(() => {});
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const pending = clientPromise;
    clientPromise = null;
    idleTimer = null;
    void pending?.then(client => client.disconnect()).catch(() => {});
  }, IDLE_DISCONNECT_MS);
}

/* ── The client ────────────────────────────────────────────────────────────── */

/**
 * Build and connect a client for `session` ("" starts an authorisation).
 *
 * `useWSS` is the whole difference from the server's client: a browser has no
 * raw TCP, and GramJS reaches Telegram's `*.web.telegram.org` endpoints over
 * a websocket instead. Those hostnames are also the only ones the page's
 * Content-Security-Policy allows, and the only ones with a usable certificate.
 */
async function buildClient(session: string, config: DirectConfig): Promise<TelegramClient> {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  const client = new TelegramClient(new StringSession(session), config.apiId, config.apiHash, {
    useWSS: true,
    connectionRetries: 3,
    requestRetries: 3
  });
  await client.connect();
  return client;
}

/** Connect once per tab using this browser's own session, and keep the socket. */
async function connected(user: string): Promise<TelegramClient> {
  if (!clientPromise) {
    const pending = (async () => {
      const config = await directConfig();
      if (!config) throw new DirectUploadUnavailable("Direct upload is not enabled for this account.");
      const session = storedSession(user);
      if (!session) throw new DirectUploadUnavailable("This browser is not connected to Telegram yet.");
      return buildClient(session, config);
    })();
    // A failed connect must not stay memoised, or the tab never retries.
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = null;
    });
    clientPromise = pending;
  }
  touchIdle();
  return clientPromise;
}

export class DirectUploadUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DirectUploadUnavailable";
  }
}

/* ── Authorising this browser ──────────────────────────────────────────────── */

export type QrHandlers = {
  phoneNumber?: string;
  onCode?: (viaApp?: boolean) => Promise<string>;
  /** Called with each fresh `tg://login?token=…` URL to render as a QR code.
   *  Telegram reissues the token every ~30s, so this fires more than once. */
  onQr: (url: string, expiresAt: number) => void;
  /** Resolve with the account's 2FA password, or reject to abandon the login. */
  onPassword: (hint?: string) => Promise<string>;
};

export async function signInBrowser(
  client: Pick<TelegramClient, "signInUser" | "signInUserWithQrCode">,
  config: DirectConfig,
  handlers: QrHandlers
) {
  if (handlers.phoneNumber) {
    return client.signInUser(
      { apiId: config.apiId, apiHash: config.apiHash },
      {
        phoneNumber: handlers.phoneNumber,
        phoneCode: viaApp => {
          if (!handlers.onCode) throw new Error("A code prompt is required.");
          return handlers.onCode(viaApp);
        },
        password: hint => handlers.onPassword(hint),
        firstAndLastNames: async () => { throw new Error("Use an existing Telegram account."); },
        onError: async err => { throw err; }
      }
    );
  }
  return client.signInUserWithQrCode(
    { apiId: config.apiId, apiHash: config.apiHash },
    {
      qrCode: async ({ token, expires }) => {
        const encoded = btoa(String.fromCharCode(...new Uint8Array(token)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        handlers.onQr(`tg://login?token=${encoded}`, expires * 1000);
      },
      password: async hint => handlers.onPassword(hint),
      onError: async err => {
        if (err.message === "Login cancelled.") throw err;
        console.warn("[direct-upload] qr login:", err.message);
        // false = keep trying; the helper reissues an expired token itself.
        return false;
      }
    }
  );
}

/**
 * Log this browser in to Telegram by QR or phone code and keep its own session.
 *
 * Resolves with the Telegram display name once the scan is accepted.
 */
export async function linkBrowser(user: string, handlers: QrHandlers): Promise<string> {
  const config = await directConfig();
  if (!config) throw new DirectUploadUnavailable("Direct upload is not enabled for this account.");

  // Always a fresh, empty session: an authorisation mutates the session in
  // place, so starting from a stale one would authorise over the top of it.
  const client = await buildClient("", config);
  try {
    const me = await signInBrowser(client, config, handlers);
    if (!("firstName" in me)) throw new Error("Telegram did not return an account.");

    const { StringSession } = await import("telegram/sessions");
    rememberSession(user, (client.session as InstanceType<typeof StringSession>).save());
    // The next upload reconnects from the stored session rather than reusing
    // this one, which keeps exactly one place that owns the connection.
    forgetDirectSession();
    await client.disconnect().catch(() => {});

    return [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Telegram";
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw err;
  }
}

/**
 * Log this browser's session out at Telegram's end, then forget it.
 *
 * Revoking matters: merely clearing storage would leave an authorised device
 * on the account that the user can no longer see a reason for.
 */
export async function unlinkBrowser(user: string): Promise<void> {
  const session = storedSession(user);
  const config = await directConfig();
  // Clear locally first, so a failure to reach Telegram still leaves the
  // browser unlinked rather than stuck holding a key it cannot drop.
  forgetStoredSession(user);
  forgetDirectSession();
  if (!session || !config) return;
  try {
    const { Api } = await import("telegram");
    const client = await buildClient(session, config);
    await client.invoke(new Api.auth.LogOut());
    await client.disconnect().catch(() => {});
  } catch (err) {
    console.warn("[direct-upload] could not revoke the browser session:", (err as Error)?.message);
  }
}

/* ── The upload ────────────────────────────────────────────────────────────── */

/**
 * Send `file` to the user's own Saved Messages and return the message it became.
 *
 * `onProgress` reports bytes, matching the relay path's contract, so the
 * caller's progress maths does not need to know which road was taken.
 */
export async function uploadDirect({
  user,
  file,
  caption,
  onProgress,
  signal
}: {
  user: string;
  file: File;
  caption?: string;
  onProgress: (loadedBytes: number) => void;
  signal?: AbortSignal;
}): Promise<{ messageId: number }> {
  if (file.size > MAX_DIRECT_BYTES) {
    throw new DirectUploadUnavailable("File is past Telegram's 4000-part ceiling for one upload.");
  }
  const client = await connected(user);
  const { Api } = await import("telegram");

  // GramJS cancels an upload by setting `isCanceled` on the callback it was
  // handed, which is why this is a function with a property rather than a
  // bare arrow passed inline.
  const report: ((progress: number) => void) & { isCanceled?: boolean } = (progress: number) => {
    // Held just under the total until the message exists, so the bar never
    // sits at a finished 100% while sendFile is still in flight.
    onProgress(Math.min(Math.round(progress * file.size), Math.max(0, file.size - 1)));
  };
  const onAbort = () => {
    report.isCanceled = true;
  };
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const handle = await client.uploadFile({ file, workers: WORKERS, onProgress: report });
    touchIdle();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const message = await client.sendFile("me", {
      file: handle,
      forceDocument: true,
      caption: caption?.slice(0, 1000),
      attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })]
    });
    touchIdle();
    onProgress(file.size);
    return { messageId: message.id };
  } catch (err) {
    // The stored session has been revoked, from Telegram → Devices or by a
    // second client. Drop it so the UI offers a scan instead of failing every
    // upload from here on.
    const message = (err as { errorMessage?: string })?.errorMessage || (err as Error)?.message || "";
    if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED/i.test(message)) {
      forgetStoredSession(user);
      forgetDirectSession();
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
