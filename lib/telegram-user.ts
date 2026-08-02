import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import { requireEnv } from "@/lib/env";
import { MTPROTO_PART_SIZE } from "@/lib/upload-config";

/**
 * Per-user MTProto ("personal session") access.
 *
 * This is the only route to true multi-gigabyte single files: the Bot API can
 * download at most 20 MB, so bot storage has to chunk, whereas a real user
 * session stores one 2 GB file (4 GB with Premium) as a single message.
 *
 * Everything here is written to survive serverless: a client is rebuilt from the
 * session string on each invocation, and Telegram keys an in-progress big-file
 * upload on (user, fileId) server-side, so parts may arrive across many separate
 * requests. That is what makes 2 GB uploads possible under a 4.5 MB body limit.
 */

const clients = new Map<string, TelegramClient>();

function apiCredentials() {
  return { apiId: Number(requireEnv("API_ID")), apiHash: String(requireEnv("API_HASH")) };
}

export function mtprotoConfigured() {
  return Boolean(process.env.API_ID && process.env.API_HASH);
}

function build(sessionString: string) {
  const { apiId, apiHash } = apiCredentials();
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
    requestRetries: 3
  });
}

/**
 * Best-effort muzzle for GramJS's background update loop.
 *
 * Nothing here consumes updates — files move explicitly and the bot has its own
 * webhook — but the loop still raises `Error: TIMEOUT` around disconnects and
 * freshly opened data centres. Measured honestly: this override does *not*
 * reliably bind (GramJS holds its own reference), and the library logs and
 * swallows those timeouts itself, so they are noise in the log rather than a
 * thrown failure.
 *
 * It is kept because it costs nothing where it does bind, but it is not what
 * makes the redeem safe. That is the combination of a fresh fully-handshaked
 * client per data centre, `withTimeout` plus retries around the one call that
 * matters, and persisting the migrated session — none of which depend on the
 * update loop behaving.
 */
function silenceBackgroundErrors(client: TelegramClient) {
  const loop = (client as unknown as { _updateLoop?: () => Promise<unknown> })._updateLoop;
  if (typeof loop === "function") {
    (client as unknown as { _updateLoop: () => Promise<unknown> })._updateLoop = function patched() {
      return Promise.resolve(loop.call(this)).catch(err => {
        tgLog("update loop suppressed:", (err as Error)?.message);
      });
    };
  }
}

/** Reject if a call outlives `ms`, so one stuck invoke cannot hold a request. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Connect a client for an *existing* session, reusing the socket within this
 * process.
 *
 * Only non-empty sessions are ever cached. A client built from "" mutates its
 * own session in place as it authorises (and again when Telegram migrates it to
 * another data centre), so caching it under the key "" would hand the next
 * person who started a login a client already half-authorised as someone else.
 */
async function connect(sessionString: string): Promise<TelegramClient> {
  if (!sessionString) return connectFresh();

  const cached = clients.get(sessionString);
  if (cached?.connected) {
    lastUsed.set(sessionString, Date.now());
    return cached;
  }

  const client = build(sessionString);
  silenceBackgroundErrors(client);
  await client.connect();
  clients.set(sessionString, client);
  lastUsed.set(sessionString, Date.now());
  startReaper();
  return client;
}

/**
 * Keeping sockets warm is the point of the cache — a cold MTProto handshake
 * costs a second or two, which was paid on *every* serverless invocation. On an
 * always-on host the opposite risk appears: a map that only ever grows, holding
 * a socket per user who has ever uploaded.
 *
 * So idle clients are disconnected after a while. The next call simply
 * reconnects, which is the same cost serverless paid every time.
 */
const IDLE_TTL_MS = 10 * 60_000;
const REAP_EVERY_MS = 60_000;
const lastUsed = new Map<string, number>();
let reaper: ReturnType<typeof setInterval> | null = null;

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [session, when] of lastUsed) {
      if (when > cutoff) continue;
      const client = clients.get(session);
      clients.delete(session);
      lastUsed.delete(session);
      void client?.disconnect().catch(() => {});
    }
    if (!clients.size && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, REAP_EVERY_MS);
  // Never hold the process open just to reap idle sockets.
  reaper.unref?.();
}

/** A brand-new, never-cached client for starting an authorisation flow. */
async function connectFresh(): Promise<TelegramClient> {
  const client = build("");
  silenceBackgroundErrors(client);
  await client.connect();
  return client;
}

/** Drop a session's cached socket — used when Telegram tells us it is dead. */
export function forgetSession(sessionString: string) {
  const cached = clients.get(sessionString);
  clients.delete(sessionString);
  lastUsed.delete(sessionString);
  void cached?.disconnect().catch(() => {});
}

/** Run `fn` against a client built from `sessionString` (empty string = fresh). */
export async function withUserClient<T>(sessionString: string, fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const client = await connect(sessionString);
  return fn(client);
}

// ── Authorisation: QR ────────────────────────────────────────────────────────

export type QrStart = { pendingSession: string; qrUrl: string; expiresAt: number };

/** Step 1 of QR login: export a login token and hand back the tg:// URL to render.
 *  The half-built session must be persisted — step 2 needs the same auth key. */
export async function startQrLogin(): Promise<QrStart> {
  const { apiId, apiHash } = apiCredentials();
  const client = await connectFresh();
  try {
    const result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
    if (!(result instanceof Api.auth.LoginToken)) {
      throw new Error("Telegram did not return a QR login token.");
    }
    const token = Buffer.from(result.token).toString("base64url");
    return {
      pendingSession: (client.session as StringSession).save(),
      qrUrl: `tg://login?token=${token}`,
      expiresAt: result.expires * 1000
    };
  } finally {
    // Uncached client — the auth key lives on in the saved session string, so
    // releasing the socket here costs nothing and avoids leaking one per start.
    await client.disconnect().catch(() => {});
  }
}

export type QrPoll =
  /** Not scanned yet. `qrUrl` is the *current* token and must be redrawn.
   *  `state` distinguishes plain waiting from a data-centre migration in
   *  progress, so the panel can say which rather than spinning identically. */
  | { status: "pending"; pendingSession: string; qrUrl?: string; expiresAt?: number; state?: "waiting" | "migrating" }
  | { status: "password"; pendingSession: string }
  | { status: "authorized"; session: string; userId: string; premium: boolean; name: string };

/**
 * Diagnostics for the QR handshake, off unless DEBUG_TG_LINK=1.
 *
 * Session strings and tokens are credentials, so nothing here prints them —
 * only class names, data-centre ids and lengths, which is all that is needed to
 * tell the branches apart in a log.
 */
export function tgLog(...parts: unknown[]) {
  if (process.env.DEBUG_TG_LINK !== "1") return;
  console.log("[tg-link]", ...parts);
}

function currentDc(client: TelegramClient) {
  try {
    return (client.session as StringSession).dcId;
  } catch {
    return "?";
  }
}

const REDEEM_TIMEOUT_MS = 25_000;
const REDEEM_ATTEMPTS = 3;

/**
 * Telegram's production data centres, as a last resort.
 *
 * The addresses are asked for at run time via help.getConfig, which is
 * authoritative and survives Telegram moving a DC. This table only exists so a
 * failed config lookup does not strand a login that has *already been scanned* —
 * these five addresses are public and long-stable, and a wrong guess simply
 * fails the connect, which the retry loop already handles.
 */
const FALLBACK_DC: Record<number, { ipAddress: string; port: number }> = {
  1: { ipAddress: "149.154.175.53", port: 443 },
  2: { ipAddress: "149.154.167.51", port: 443 },
  3: { ipAddress: "149.154.175.100", port: 443 },
  4: { ipAddress: "149.154.167.91", port: 443 },
  5: { ipAddress: "91.108.56.130", port: 443 }
};

/** Ask the connected client where a data centre lives, falling back to the table. */
async function resolveDcAddress(source: TelegramClient, dcId: number) {
  try {
    if (!source.connected) throw new Error("source client is not connected");
    const dc = await withTimeout(source.getDC(dcId, false), 15_000, `getDC(${dcId})`);
    if (dc?.ipAddress) return { ipAddress: dc.ipAddress, port: dc.port || 443 };
    throw new Error("getDC returned no address");
  } catch (err) {
    const fallback = FALLBACK_DC[dcId];
    tgLog("getDC failed:", (err as Error)?.message, "— falling back to table:", Boolean(fallback));
    if (!fallback) throw err;
    return fallback;
  }
}

/**
 * Redeem an accepted QR token on the data centre Telegram migrated it to.
 *
 * A brand-new client is built and pointed at the target DC before connecting, so
 * `connect()` performs the full handshake there rather than patching a live
 * connection mid-flight. The token is the bearer — it authorises this new
 * session regardless of which DC issued it.
 *
 * Each attempt is bounded and retried, because the first call against a
 * just-opened DC connection is the one that was timing out in production. On
 * exhaustion the migrated session is still returned so the caller can persist
 * it: the next poll then starts on the correct DC instead of replaying the
 * whole migration, which is what made the old code loop forever.
 */
async function redeemMigratedToken(
  source: TelegramClient,
  dcId: number,
  token: Buffer,
  previous: string
): Promise<QrPoll> {
  const { apiId, apiHash } = apiCredentials();

  // Resolve the target address on the *connected* source client. getDC issues
  // help.getConfig under the hood, so asking a freshly-built client throws
  // "Cannot send requests while disconnected" before the redeem even starts —
  // which is exactly how this failed in production.
  const address = await resolveDcAddress(source, dcId);
  tgLog("resolved dc=", dcId, "->", address.ipAddress + ":" + address.port);

  const session = new StringSession("");
  // Point the session at the target DC *before* the client is constructed, so
  // connect() performs the whole handshake there and no request is ever issued
  // on an unconnected client.
  session.setDC(dcId, address.ipAddress, address.port);

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
    requestRetries: 3
  });

  silenceBackgroundErrors(client);
  await client.connect();
  tgLog("connected to dc=", dcId, "for redeem");

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= REDEEM_ATTEMPTS; attempt++) {
    try {
      const imported = await withTimeout(
        client.invoke(new Api.auth.ImportLoginToken({ token })),
        REDEEM_TIMEOUT_MS,
        `importLoginToken attempt ${attempt}`
      );
      tgLog("import attempt", attempt, "->", imported.className);

      if (imported instanceof Api.auth.LoginTokenSuccess) {
        tgLog("migration authorised on dc=", dcId);
        // Cache and hand back under the *migrated* session.
        const saved = session.save();
        clients.delete(previous);
        lastUsed.delete(previous);
        clients.set(saved, client);
        lastUsed.set(saved, Date.now());
        return authorizedResult(client, previous);
      }
      // Anything else means the token is not (yet) redeemable here; retrying the
      // same token would only repeat the answer.
      break;
    } catch (err) {
      lastError = err as Error;
      const message = (err as { errorMessage?: string })?.errorMessage || (err as Error)?.message || "";
      tgLog("import attempt", attempt, "failed:", message);
      // A 2FA account answers the redeem with this; it is a result, not a fault.
      if (needsPassword(err)) {
        const saved = session.save();
        clients.set(saved, client);
        lastUsed.set(saved, Date.now());
        return { status: "password", pendingSession: saved };
      }
      if (attempt < REDEEM_ATTEMPTS) await new Promise(r => setTimeout(r, 1_000 * attempt));
    }
  }

  // Keep the migrated session either way — the next poll resumes on this DC.
  const saved = session.save();
  clients.set(saved, client);
  lastUsed.set(saved, Date.now());
  tgLog("redeem unresolved on dc=", dcId, "— persisting migrated session;", lastError?.message ?? "no error");
  return { status: "pending", pendingSession: saved, state: "migrating" };
}

/** A "keep waiting" answer that carries the freshest token and session string. */
function pendingWithToken(
  client: TelegramClient,
  previous: string,
  token?: Api.auth.LoginToken,
  state: "waiting" | "migrating" = "waiting"
): QrPoll {
  const next = (client.session as StringSession).save();
  if (next !== previous) {
    clients.delete(previous);
    lastUsed.delete(previous);
    clients.set(next, client);
    lastUsed.set(next, Date.now());
  }
  tgLog("pending", state, "sessionRotated=", next !== previous, "hasToken=", Boolean(token));
  return {
    status: "pending",
    pendingSession: next,
    state,
    ...(token
      ? {
          qrUrl: `tg://login?token=${Buffer.from(token.token).toString("base64url")}`,
          expiresAt: token.expires * 1000
        }
      : {})
  };
}

/** Step 2 of QR login: re-export the token; Telegram answers with the account
 *  once the user has scanned it. `migrateTo` means retry against another DC. */
export async function pollQrLogin(pendingSession: string): Promise<QrPoll> {
  const { apiId, apiHash } = apiCredentials();
  const client = await connect(pendingSession);
  try {
    const result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
    tgLog("export ->", result.className, "dc=", currentDc(client));

    if (result instanceof Api.auth.LoginTokenSuccess) {
      tgLog("LOGIN_TOKEN_SUCCESS on first export — authorising");
      return authorizedResult(client, pendingSession);
    }

    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      // The scan already happened; it only becomes an authorisation once the
      // token is redeemed on the data centre Telegram nominates here.
      //
      // `_switchDC` was the wrong tool: it mutates a live client in place, and
      // the half-migrated result timed out on the very first call against the
      // new DC. A fresh client for the target DC gets the whole documented
      // handshake — auth key, initConnection, invokeWithLayer — from connect(),
      // which is what the redeem needs.
      tgLog("LOGIN_TOKEN_MIGRATE_TO dc=", result.dcId, "(from dc=", currentDc(client), ") — redeeming on target DC");
      return redeemMigratedToken(client, result.dcId, result.token, pendingSession);
    }
    // Not scanned yet — and `result` is a *brand new* token, because
    // auth.exportLoginToken issues one on every call and invalidates the last.
    // The QR already on screen is therefore dead, so it must be handed back and
    // redrawn; otherwise the user scans a superseded token, their phone reports
    // success, and this session waits forever for an acceptance that can never
    // arrive. This is also what keeps the code fresh past its ~30 s expiry.
    return pendingWithToken(client, pendingSession, result as Api.auth.LoginToken, "waiting");
  } catch (err) {
    tgLog("poll threw:", (err as { errorMessage?: string })?.errorMessage || (err as Error)?.message);
    if (needsPassword(err)) {
      // The client authorised far enough to need a password; its session string
      // has moved on, so drop the entry filed under the old one rather than
      // leaving a second socket cached against a stale key.
      const next = (client.session as StringSession).save();
      if (next !== pendingSession) {
        clients.delete(pendingSession);
        clients.set(next, client);
      }
      return { status: "password", pendingSession: next };
    }
    throw err;
  }
}

/** Telegram signals a 2FA account by failing the sign-in with this code. */
function needsPassword(error: unknown) {
  const code = (error as { errorMessage?: string })?.errorMessage ?? "";
  return code === "SESSION_PASSWORD_NEEDED" || String((error as Error)?.message ?? "").includes("SESSION_PASSWORD_NEEDED");
}

async function authorizedResult(client: TelegramClient, previousKey?: string): Promise<Authorized> {
  const me = (await client.getMe()) as Api.User;
  const session = (client.session as StringSession).save();
  tgLog("authorized userId=", String(me.id), "premium=", Boolean(me.premium), "sessionLen=", session.length);
  // The client authorised in place, so any cache entry under the half-built
  // session string now points at a session string that no longer describes it.
  if (previousKey && previousKey !== session) clients.delete(previousKey);
  clients.set(session, client);
  return {
    status: "authorized",
    session,
    userId: String(me.id),
    premium: Boolean(me.premium),
    name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Telegram user"
  };
}

// ── Authorisation: phone + code ──────────────────────────────────────────────

/** Normalise to the E.164-ish form Telegram expects: digits with a leading +. */
export function normalisePhone(input: string) {
  const digits = input.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

export async function startPhoneLogin(phone: string): Promise<{ pendingSession: string; phoneCodeHash: string }> {
  const { apiId, apiHash } = apiCredentials();
  const client = await connectFresh();
  try {
    // gramjs transparently follows the PHONE_MIGRATE_x redirect this can raise,
    // reconnecting to the user's home data centre; the saved session records it.
    const sent = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: normalisePhone(phone),
        apiId,
        apiHash,
        settings: new Api.CodeSettings({})
      })
    );
    if (!(sent instanceof Api.auth.SentCode)) {
      throw new Error("Telegram could not send a login code to that number.");
    }
    return { pendingSession: (client.session as StringSession).save(), phoneCodeHash: sent.phoneCodeHash };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export type Authorized = { status: "authorized"; session: string; userId: string; premium: boolean; name: string };
export type SignInResult = { status: "password"; pendingSession: string } | Authorized;

export async function signInWithCode(
  pendingSession: string,
  phone: string,
  phoneCodeHash: string,
  code: string
): Promise<SignInResult> {
  const client = await connect(pendingSession);
  try {
    await client.invoke(
      new Api.auth.SignIn({ phoneNumber: normalisePhone(phone), phoneCodeHash, phoneCode: code })
    );
  } catch (err) {
    if (needsPassword(err)) {
      // The client authorised far enough to need a password; its session string
      // has moved on, so drop the entry filed under the old one rather than
      // leaving a second socket cached against a stale key.
      const next = (client.session as StringSession).save();
      if (next !== pendingSession) {
        clients.delete(pendingSession);
        clients.set(next, client);
      }
      return { status: "password", pendingSession: next };
    }
    throw err;
  }
  return authorizedResult(client, pendingSession);
}

/** Two-factor step — required when the account has a cloud password set. */
export async function signInWithPassword(pendingSession: string, password: string): Promise<Authorized> {
  const client = await connect(pendingSession);
  const pwd = await client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(pwd, password);
  await client.invoke(new Api.auth.CheckPassword({ password: check }));
  return authorizedResult(client, pendingSession);
}

// ── Big-file upload ──────────────────────────────────────────────────────────

/**
 * Push one slice of a big file. `offsetPart` is the index of the first 512 KiB
 * part contained in `data`, so a 4 MiB browser chunk covers 8 consecutive parts.
 * Telegram accepts parts in any order across any number of connections.
 */
export async function saveBigFileParts(
  session: string,
  fileId: string,
  offsetPart: number,
  totalParts: number,
  data: Buffer
): Promise<number> {
  const client = await connect(session);
  const id = bigInt(fileId);
  let written = 0;
  for (let at = 0; at < data.length; at += MTPROTO_PART_SIZE) {
    const slice = data.subarray(at, Math.min(at + MTPROTO_PART_SIZE, data.length));
    await client.invoke(
      new Api.upload.SaveBigFilePart({
        fileId: id,
        filePart: offsetPart + written,
        fileTotalParts: totalParts,
        bytes: slice
      })
    );
    written++;
  }
  return written;
}

/** Turn the uploaded parts into a real message in the user's Saved Messages. */
export async function finalizeBigFile(params: {
  session: string;
  fileId: string;
  totalParts: number;
  fileName: string;
  mimeType: string;
  caption?: string;
}): Promise<{ messageId: number }> {
  const client = await connect(params.session);
  const input = new Api.InputFileBig({
    id: bigInt(params.fileId),
    parts: params.totalParts,
    name: params.fileName
  });
  const message = await client.sendFile("me", {
    file: input,
    forceDocument: true,
    caption: params.caption?.slice(0, 1000),
    attributes: [new Api.DocumentAttributeFilename({ fileName: params.fileName })]
  });
  return { messageId: message.id };
}

// ── Ranged download ──────────────────────────────────────────────────────────

type DocumentRef = { id: bigInt.BigInteger; accessHash: bigInt.BigInteger; fileReference: Buffer; dcId: number };

async function resolveDocument(client: TelegramClient, msgId: number): Promise<DocumentRef> {
  const messages = await client.getMessages("me", { ids: [msgId] });
  const media = messages[0]?.media;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
    throw new Error(`Message ${msgId} no longer holds a document.`);
  }
  const doc = media.document;
  return {
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: Buffer.from(doc.fileReference),
    dcId: doc.dcId
  };
}

/**
 * Read `[start, end]` (inclusive) of an MTProto-stored file.
 *
 * Telegram requires offsets aligned to the part size, so we round down, fetch
 * whole parts, and trim. Nothing larger than the requested window is ever held
 * in memory — that is what keeps a 2 GB file streamable from a 1 GB function.
 */
export async function downloadRange(session: string, msgId: number, start: number, end: number): Promise<Buffer> {
  const client = await connect(session);
  const doc = await resolveDocument(client, msgId);

  const alignedStart = Math.floor(start / MTPROTO_PART_SIZE) * MTPROTO_PART_SIZE;
  const wanted = end - start + 1;
  const toFetch = start - alignedStart + wanted;

  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: ""
  });

  const parts: Buffer[] = [];
  let collected = 0;
  const iterator = client.iterDownload({
    file: location,
    offset: bigInt(alignedStart),
    requestSize: MTPROTO_PART_SIZE,
    limit: Math.ceil(toFetch / MTPROTO_PART_SIZE),
    dcId: doc.dcId
  });
  for await (const buf of iterator) {
    parts.push(buf as Buffer);
    collected += (buf as Buffer).length;
    if (collected >= toFetch) break;
  }
  await iterator.close();

  const joined = Buffer.concat(parts);
  const from = start - alignedStart;
  return joined.subarray(from, from + wanted);
}

/** Remove an MTProto-stored file from the user's Saved Messages. */
export async function deleteUserMessages(session: string, msgIds: number[]): Promise<void> {
  if (!msgIds.length) return;
  try {
    const client = await connect(session);
    for (let i = 0; i < msgIds.length; i += 100) {
      await client.deleteMessages("me", msgIds.slice(i, i + 100), { revoke: true });
    }
  } catch (err) {
    console.error("[telegram-user] deleteMessages failed:", (err as Error).message);
  }
}
