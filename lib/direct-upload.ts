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
import { DIRECT_MAX_BYTES, uploadDirectParts } from "@/lib/direct-parts";

export type DirectConfig = { enabled: boolean; apiId: number; apiHash: string; telegramUserId?: string };

/** Drop the socket after a quiet spell rather than holding one open all day. */
const IDLE_DISCONNECT_MS = 2 * 60_000;

const sessionKey = (user: string) => `td:${user}:tg-session:v1`;

let configPromise: Promise<DirectConfig | null> | null = null;
let clientPromise: Promise<TelegramClient> | null = null;
let clientUser: string | null = null;
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
    if (storedSession(user) !== session) throw new Error("Session was not saved");
  } catch {
    throw new DirectUploadUnavailable("This device could not save the Telegram connection. Allow app storage and try again.");
  }
}

function forgetStoredSession(user: string) {
  try {
    window.localStorage.removeItem(sessionKey(user));
  } catch {
    /* already gone as far as anyone can tell */
  }
}

function forgetRevokedSession(user: string, error: unknown) {
  const reason = (error as { errorMessage?: string })?.errorMessage || (error as Error)?.message || "";
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED/i.test(reason)) {
    forgetStoredSession(user);
    if (clientUser === user) forgetDirectSession();
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
      const res = await fetch("/api/telegram/direct-session", {
        credentials: "same-origin",
        cache: "no-store"
      });
      if (res.status === 403) {
        const body = await res.json();
        if (body.enabled === false) return null;
      }
      if (!res.ok) throw new DirectUploadUnavailable("Could not check direct upload. No file bytes were sent. Try again.");
      const body = (await res.json()) as Partial<DirectConfig>;
      if (!body?.enabled || !body.apiId || !body.apiHash) throw new DirectUploadUnavailable("Direct upload configuration is incomplete.");
      return { enabled: true, apiId: body.apiId, apiHash: body.apiHash, telegramUserId: body.telegramUserId };
    })().catch(error => {
      configPromise = null;
      if (error instanceof DirectUploadUnavailable) throw error;
      throw new DirectUploadUnavailable("Could not reach direct-upload settings. No file bytes were sent. Retry when connected.");
    });
  }
  return configPromise;
}

/** Forget what this tab is holding, without touching Telegram or storage. */
export function forgetDirectSession() {
  configPromise = null;
  const pending = clientPromise;
  clientPromise = null;
  clientUser = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  void pending?.then(retire).catch(() => {});
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const pending = clientPromise;
    clientPromise = null;
    idleTimer = null;
    void pending?.then(retire).catch(() => {});
  }, IDLE_DISCONNECT_MS);
}

/**
 * Throw a client away for good: destroy(), never disconnect().
 *
 * GramJS keeps a ping loop per client that ends only when `_destroyed` is set,
 * which destroy() does and disconnect() does not. A disconnected client's loop
 * goes on pinging every 9 seconds, logs `Error: TIMEOUT` when the ping fails,
 * and then reconnects the socket that was just closed - so every idle timeout
 * in this tab left a zombie connection to Telegram running until the page
 * closed, costing battery and data on a phone. Found on the server first
 * (TeleDrive #51), where the same mistake leaked memory.
 */
async function retire(client: TelegramClient | null | undefined): Promise<void> {
  if (!client) return;
  await client.destroy().catch(() => {});
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
  try { await client.connect(); }
  catch (error) { await retire(client); throw error; }
  return client;
}

/** Connect once per tab using this browser's own session, and keep the socket. */
async function connected(user: string): Promise<TelegramClient> {
  if (clientUser !== null && clientUser !== user) forgetDirectSession();
  clientUser = user;
  if (!clientPromise) {
    const pending = (async () => {
      const config = await directConfig();
      if (!config) throw new DirectUploadUnavailable("Direct upload is not enabled for this account.");
      const session = storedSession(user);
      if (!session) throw new DirectUploadUnavailable("This browser is not connected to Telegram yet.");
      const client = await buildClient(session, config);
      try {
        assertDirectAccount(config, (await client.getMe()).id.toString());
        return client;
      } catch (error) {
        await retire(client);
        throw error;
      }
    })();
    // A failed connect must not stay memoised, or the tab never retries.
    pending.catch(error => {
      forgetRevokedSession(user, error);
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

export function assertDirectAccount(config: DirectConfig, actualUserId: string) {
  if (config.telegramUserId && config.telegramUserId !== actualUserId) {
    throw new DirectUploadUnavailable("This browser is signed into a different Telegram account. Connect the same account linked to your drive.");
  }
}

/* ── Authorising this browser ──────────────────────────────────────────────── */

export type QrHandlers = {
  signal?: AbortSignal;
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
  const checkCancelled = () => {
    if (handlers.signal?.aborted) throw new Error("Login cancelled.");
  };
  checkCancelled();
  if (handlers.phoneNumber) {
    return client.signInUser(
      { apiId: config.apiId, apiHash: config.apiHash },
      {
        phoneNumber: handlers.phoneNumber,
        phoneCode: viaApp => {
          checkCancelled();
          if (!handlers.onCode) throw new Error("A code prompt is required.");
          return handlers.onCode(viaApp);
        },
        password: hint => { checkCancelled(); return handlers.onPassword(hint); },
        firstAndLastNames: async () => { throw new Error("Use an existing Telegram account."); },
        onError: async err => { throw err; }
      }
    );
  }
  return client.signInUserWithQrCode(
    { apiId: config.apiId, apiHash: config.apiHash },
    {
      qrCode: async ({ token, expires }) => {
        checkCancelled();
        const encoded = btoa(String.fromCharCode(...new Uint8Array(token)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        handlers.onQr(`tg://login?token=${encoded}`, expires * 1000);
      },
      password: async hint => { checkCancelled(); return handlers.onPassword(hint); },
      onError: async err => {
        checkCancelled();
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
  let cancel: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Login cancelled."));
      if (handlers.signal?.aborted) cancel();
      else handlers.signal?.addEventListener("abort", cancel, { once: true });
    });
    const me = await Promise.race([signInBrowser(client, config, handlers), cancelled]);
    if (handlers.signal?.aborted) throw new Error("Login cancelled.");
    if (!("firstName" in me)) throw new Error("Telegram did not return an account.");
    assertDirectAccount(config, me.id.toString());

    const { StringSession } = await import("telegram/sessions");
    rememberSession(user, (client.session as InstanceType<typeof StringSession>).save());
    // The next upload reconnects from the stored session rather than reusing
    // this one, which keeps exactly one place that owns the connection.
    forgetDirectSession();
    await retire(client);

    return [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Telegram";
  } catch (err) {
    await retire(client);
    throw err;
  } finally {
    if (cancel) handlers.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Connect this browser right after the account was signed in on the server,
 * without a second scan: the browser shows its QR token to the server, and the
 * server's fresh session approves it. The server only does that for a few
 * minutes after a real sign-in. `password` is the two-step password the user
 * just typed, if any; a QR login needs it again.
 *
 * Resolves "connected", "already" or "off" (direct upload switched off).
 */
export async function autoConnectBrowser(user: string, password?: string): Promise<"connected" | "already" | "off"> {
  if (browserLinked(user)) return "already";
  forgetDirectSession();
  if (!(await directConfig())) return "off";
  const controller = new AbortController();
  let approving: Promise<void> | null = null;
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    await linkBrowser(user, {
      signal: controller.signal,
      onQr: url => {
        // Each refreshed token is a new request to approve; the latest wins.
        approving = fetch("/api/telegram/approve-browser", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ qrUrl: url })
        }).then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            controller.abort();
            throw new DirectUploadUnavailable(body.error || "The server could not approve this device.");
          }
        });
        approving.catch(() => {});
      },
      onPassword: async () => {
        if (password) return password;
        throw new DirectUploadUnavailable("Enter your Telegram cloud password under Direct upload to finish connecting this device.");
      }
    });
    return "connected";
  } catch (error) {
    // Prefer the server's reason over the generic "Login cancelled.".
    await (approving as Promise<void> | null)?.catch(reason => { throw reason; });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Check the saved connection without uploading a file. */
export async function checkDirectConnection(user: string): Promise<string> {
  try {
    const client = await connected(user);
    const me = await client.getMe();
    return [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Telegram";
  } catch (error) { forgetRevokedSession(user, error); throw error; }
}

/**
 * Log this browser's session out at Telegram's end, then forget it.
 *
 * Revoking matters: merely clearing storage would leave an authorised device
 * on the account that the user can no longer see a reason for.
 */
export async function unlinkBrowser(user: string): Promise<void> {
  const session = storedSession(user);
  const configRequest = directConfig();
  // Clear locally first, so a failure to reach Telegram still leaves the
  // browser unlinked rather than stuck holding a key it cannot drop.
  forgetStoredSession(user);
  forgetDirectSession();
  // The Android app keeps a copy for background backup; drop that too.
  const app = (window as unknown as { Capacitor?: { Plugins?: { Backup?: { directCredentials?: (o: object) => Promise<unknown> } } } }).Capacitor;
  await app?.Plugins?.Backup?.directCredentials?.({ session: "", apiId: 0 })?.catch(() => {});
  let client: TelegramClient | undefined;
  try {
    const config = await configRequest;
    if (!session || !config) return;
    const { Api } = await import("telegram");
    client = await buildClient(session, config);
    await client.invoke(new Api.auth.LogOut());
  } catch (err) {
    console.warn("[direct-upload] could not revoke the browser session:", (err as Error)?.message);
  } finally {
    await retire(client);
  }
}

/* ── The download ──────────────────────────────────────────────────────────── */

/** Telegram's largest file request, and how many are kept in flight. */
const DIRECT_READ_PART = 512 * 1024;
const DIRECT_READ_PARALLEL = 4;

/**
 * Read a file stored in the user's own Saved Messages straight from Telegram.
 *
 * Only `backend: "mtproto"` files qualify: their message id belongs to the
 * user's account, the same account this browser is signed into. Bot-stored
 * chunks live in the bot's chat under the bot's message ids and file ids,
 * which a user client cannot address, so those still come through the server.
 */
export async function* downloadDirect(user: string, messageId: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const client = await connected(user);
  const { Api } = await import("telegram");
  try {
    const [message] = await client.getMessages("me", { ids: [messageId] });
    const media = message?.media;
    if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
      throw new DirectUploadUnavailable("This file is no longer in your Telegram Saved Messages.");
    }
    const doc = media.document;
    const location = new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: "" });
    const { default: bigInt } = await import("big-integer");
    // Parts are requested a few at a time rather than one after another: each
    // request is a round trip to Telegram, and waiting for every one in turn
    // made a 27 MB video take most of a minute on a phone.
    const sender = await client.getSender(doc.dcId);
    const total = Number(doc.size?.toString() ?? 0);
    if (!total) throw new DirectUploadUnavailable("Telegram did not report this file's size.");
    const count = Math.ceil(total / DIRECT_READ_PART);
    const inflight = new Map<number, Promise<Uint8Array>>();
    let next = 0;
    const fill = () => {
      while (next < count && inflight.size < DIRECT_READ_PARALLEL) {
        const index = next++;
        const request = Promise.resolve(
          sender.send(new Api.upload.GetFile({ location, offset: bigInt(index * DIRECT_READ_PART), limit: DIRECT_READ_PART }))
        ).then(result => {
            if (!(result instanceof Api.upload.File)) throw new DirectUploadUnavailable("Telegram moved this file. Use the file server for it.");
            return new Uint8Array(result.bytes);
          });
        request.catch(() => {}); // awaited below; this only silences an early abort
        inflight.set(index, request);
      }
    };
    for (let index = 0; index < count; index++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      fill();
      const part = await inflight.get(index)!;
      inflight.delete(index);
      touchIdle();
      yield part;
    }
  } catch (err) {
    forgetRevokedSession(user, err);
    throw err;
  }
}

/** Where a Saved Messages file lives, so each seek is one round trip, not two. */
type DocRef = { location: unknown; dcId: number; size: number };
const docRefs = new Map<string, Promise<DocRef>>();

async function resolveDoc(client: TelegramClient, user: string, messageId: number): Promise<DocRef> {
  const key = `${user}:${messageId}`;
  let pending = docRefs.get(key);
  if (!pending) {
    pending = (async () => {
      const { Api } = await import("telegram");
      const [message] = await client.getMessages("me", { ids: [messageId] });
      const media = message?.media;
      if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
        throw new DirectUploadUnavailable("This file is no longer in your Telegram Saved Messages.");
      }
      const doc = media.document;
      return {
        location: new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: "" }),
        dcId: doc.dcId,
        size: Number(doc.size?.toString() ?? 0)
      };
    })();
    pending.catch(() => docRefs.delete(key));
    docRefs.set(key, pending);
  }
  return pending;
}

/**
 * Bytes `start`–`end` (inclusive) of a Saved Messages file, read on this device.
 *
 * This is what lets a video play straight from Telegram: the service worker
 * turns the player's Range requests into calls to this. Telegram only serves
 * whole 512 KB-aligned parts, so the window is widened to part boundaries,
 * fetched in parallel, and trimmed. A file reference goes stale after a while;
 * that is refreshed once rather than failing the seek.
 */
export async function readDirectRange(user: string, messageId: number, start: number, end: number): Promise<Uint8Array> {
  const client = await connected(user);
  const { Api } = await import("telegram");
  const { default: bigInt } = await import("big-integer");
  const read = async (doc: DocRef) => {
    const last = Math.min(end, doc.size - 1);
    const first = Math.floor(start / DIRECT_READ_PART);
    const sender = await client.getSender(doc.dcId);
    const parts = await Promise.all(
      Array.from({ length: Math.floor(last / DIRECT_READ_PART) - first + 1 }, async (_, i) => {
        const result = await sender.send(
          new Api.upload.GetFile({ location: doc.location as InstanceType<typeof Api.InputDocumentFileLocation>, offset: bigInt((first + i) * DIRECT_READ_PART), limit: DIRECT_READ_PART })
        );
        if (!(result instanceof Api.upload.File)) throw new DirectUploadUnavailable("Telegram moved this file. Use the file server for it.");
        return new Uint8Array(result.bytes);
      })
    );
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.byteLength; }
    const from = start - first * DIRECT_READ_PART;
    return joined.subarray(from, from + (last - start + 1));
  };
  try {
    try {
      return await read(await resolveDoc(client, user, messageId));
    } catch (error) {
      if (!/FILE_REFERENCE/i.test((error as { errorMessage?: string })?.errorMessage || (error as Error)?.message || "")) throw error;
      docRefs.delete(`${user}:${messageId}`);
      return await read(await resolveDoc(client, user, messageId));
    }
  } catch (error) {
    forgetRevokedSession(user, error);
    throw error;
  } finally {
    touchIdle();
  }
}

/* ── Sending to someone ────────────────────────────────────────────────────── */

/**
 * Forward a Saved Messages file to another Telegram user or chat, from this
 * device. The recipient gets the real file in Telegram; no server carries it,
 * which a share link cannot offer (its viewer is not in the owner's account).
 */
/** "+91 98765 43210" → "919876543210"; a bare 10-digit number is taken as Indian (+91). */
export function telegramPhone(input: string): string | null {
  const raw = input.trim();
  if (!/^\+?[\d\s()-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  if (!raw.startsWith("+") && digits.length === 10) return `91${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** Forward Saved Messages files to a @username or phone number; returns who got them. */
export async function sendViaTelegram(user: string, messageIds: number[], to: string): Promise<string> {
  const phone = telegramPhone(to);
  const username = to.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!phone && !/^[A-Za-z0-9_]{4,32}$/.test(username)) throw new Error("Enter a Telegram @username or a phone number.");
  const shown = phone ? `+${phone}` : `@${username}`;
  const client = await connected(user);
  try {
    const { Api } = await import("telegram");
    let target: Parameters<TelegramClient["forwardMessages"]>[0] = username;
    if (phone) {
      // resolvePhone finds them without adding them to the user's contacts.
      const found = await client.invoke(new Api.contacts.ResolvePhone({ phone }));
      target = found.users[0] ?? found.peer;
    }
    // Telegram forwards at most 100 messages per request, in the order given.
    for (let i = 0; i < messageIds.length; i += 100) {
      await client.forwardMessages(target, { messages: messageIds.slice(i, i + 100), fromPeer: "me" });
    }
    return shown;
  } catch (error) {
    forgetRevokedSession(user, error);
    const reason = (error as { errorMessage?: string })?.errorMessage || (error as Error)?.message || "";
    if (/PHONE_NOT_OCCUPIED|PHONE_NUMBER_INVALID/i.test(reason)) {
      throw new Error(`No Telegram account can be found for ${shown}. They may hide their number; try their @username.`);
    }
    if (/USERNAME_(NOT_OCCUPIED|INVALID)|No user has/i.test(reason)) throw new Error(`No Telegram user is called ${shown}.`);
    throw error;
  } finally {
    touchIdle();
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
  signal,
  beforeSend
}: {
  user: string;
  file: File;
  caption?: string;
  onProgress: (loadedBytes: number) => void;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
}): Promise<{ messageId: number }> {
  if (file.size > DIRECT_MAX_BYTES) {
    throw new DirectUploadUnavailable("File is past Telegram's 4000-part ceiling for one upload.");
  }
  const client = await connected(user);
  const { Api } = await import("telegram");
  const { generateRandomLong } = await import("telegram/Helpers");
  const fileId = generateRandomLong();
  const large = file.size > 10 * 1024 * 1024;

  try {
    const parts = await uploadDirectParts(file, async (index, bytes, count) => {
      touchIdle();
      return client.invoke(large
        ? new Api.upload.SaveBigFilePart({ fileId, filePart: index, fileTotalParts: count, bytes })
        : new Api.upload.SaveFilePart({ fileId, filePart: index, bytes }));
    }, onProgress, signal, beforeSend);
    const handle = large
      ? new Api.InputFileBig({ id: fileId, parts, name: file.name })
      : new Api.InputFile({ id: fileId, parts, name: file.name, md5Checksum: "" });
    touchIdle();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const message = await client.sendFile("me", {
      file: handle,
      forceDocument: true,
      caption: caption?.slice(0, 1000),
      attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })]
    });
    touchIdle();
    onProgress(Math.max(0, file.size - 1));
    return { messageId: message.id };
  } catch (err) {
    // The stored session has been revoked, from Telegram → Devices or by a
    // second client. Drop it so the UI offers a scan instead of failing every
    // upload from here on.
    forgetRevokedSession(user, err);
    throw err;
  }
}
