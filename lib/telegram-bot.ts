import { env, requireEnv } from "@/lib/env";

/**
 * Thin Telegram Bot API client on native fetch.
 * All new storage goes through here: files are sent by the bot into each
 * user's own chat with the bot, so every user keeps data in their Telegram.
 */

const API_BASE = "https://api.telegram.org";

export class BotApiError extends Error {
  code: number;
  retryAfter?: number;
  constructor(description: string, code: number, retryAfter?: number) {
    super(description);
    this.name = "BotApiError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

type BotApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

function token(botToken?: string | null) {
  return botToken || String(requireEnv("BOT_TOKEN"));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A Telegram bot is allowed ~30 messages/second overall, and there is no
 * cross-instance coordination, so in-flight document sends are capped per
 * process. Anything beyond the cap waits its turn instead of piling into a 429
 * storm.
 *
 * Two gates, because they stop different things going wrong.
 *
 * The global gate protects the bot's ~30 msg/s budget, which is shared by every
 * user of the deployment. The per-user gate stops one uploader with a fast link
 * from occupying every global slot and starving everyone else — with a single
 * gate, raising concurrency for throughput also hands one person the whole
 * budget. Defaults scale with UPLOAD_CONCURRENCY so the two stay in proportion.
 */
const MAX_INFLIGHT_SENDS = (() => {
  const raw = Number(process.env.TELEGRAM_MAX_INFLIGHT);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 32) : 4;
})();

const MAX_INFLIGHT_PER_USER = (() => {
  const raw = Number(process.env.TELEGRAM_MAX_INFLIGHT_PER_USER);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), MAX_INFLIGHT_SENDS);
  return Math.max(1, Math.ceil(MAX_INFLIGHT_SENDS / 2));
})();

let inflight = 0;
const waiters: Array<() => void> = [];

const perUser = new Map<string, { count: number; waiters: Array<() => void> }>();

function userGate(key: string) {
  let gate = perUser.get(key);
  if (!gate) {
    gate = { count: 0, waiters: [] };
    perUser.set(key, gate);
  }
  return gate;
}

async function acquireSendSlot(userKey?: string) {
  if (userKey) {
    const gate = userGate(userKey);
    if (gate.count >= MAX_INFLIGHT_PER_USER) {
      await new Promise<void>(resolve => gate.waiters.push(resolve));
    }
    gate.count++;
  }

  if (inflight < MAX_INFLIGHT_SENDS) {
    inflight++;
    return;
  }
  await new Promise<void>(resolve => waiters.push(resolve));
  inflight++;
}

function releaseSendSlot(userKey?: string) {
  inflight--;
  waiters.shift()?.();

  if (!userKey) return;
  const gate = perUser.get(userKey);
  if (!gate) return;
  gate.count--;
  gate.waiters.shift()?.();
  // Drop idle entries so a long-lived process does not accumulate one per user
  // who ever uploaded.
  if (gate.count <= 0 && !gate.waiters.length) perUser.delete(userKey);
}

/** Full jitter exponential backoff — spreads retries so concurrent uploaders
 *  don't all come back at the same instant and re-trigger the same 429. */
function backoffDelay(attempt: number) {
  return Math.random() * Math.min(1000 * 2 ** attempt, 20_000);
}

const MAX_ATTEMPTS = 6;

/** JSON body, or a factory producing a fresh FormData per attempt — a FormData
 *  that has already been sent cannot be replayed, so retries must rebuild it. */
type BotPayload = Record<string, unknown> | (() => FormData);

async function callBotApi<T>(
  method: string,
  payload: BotPayload,
  botToken?: string | null,
  attempts = MAX_ATTEMPTS
): Promise<T> {
  const url = `${API_BASE}/bot${token(botToken)}/${method}`;
  const isForm = typeof payload === "function";

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: isForm ? undefined : { "content-type": "application/json" },
        body: isForm ? payload() : JSON.stringify(payload)
      });
    } catch (err) {
      // Transport-level failure (DNS, reset, timeout) — worth retrying.
      lastError = new BotApiError(`Telegram request failed: ${(err as Error).message}`, 0);
      if (attempt < attempts - 1) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }

    const body = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as BotApiEnvelope<T>;
    if (body.ok && body.result !== undefined) return body.result;

    const code = body.error_code || res.status;
    const retryAfter = body.parameters?.retry_after;
    const retryable = code === 429 || code >= 500;

    if (retryable && attempt < attempts - 1) {
      // Honour Telegram's retry_after exactly, plus jitter to de-sync callers.
      const wait = retryAfter ? retryAfter * 1000 + Math.random() * 500 : backoffDelay(attempt);
      await sleep(Math.min(wait, 30_000));
      continue;
    }
    throw new BotApiError(body.description || "Telegram Bot API error", code, retryAfter);
  }

  throw lastError ?? new BotApiError("Telegram Bot API error", 500);
}

// ── Messaging ────────────────────────────────────────────────────────────────

export async function sendMessageBot(
  chatId: string | number,
  text: string,
  extra: Record<string, unknown> = {},
  botToken?: string | null
) {
  return callBotApi<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...extra }, botToken);
}

/** Delete bot messages in batches of 100. Failures are logged, never thrown —
 *  Telegram refuses deletion of messages older than 48h; the app copy is the DB. */
export async function deleteMessagesBot(chatId: string | number, messageIds: number[], botToken?: string | null) {
  for (let i = 0; i < messageIds.length; i += 100) {
    try {
      await callBotApi<boolean>("deleteMessages", { chat_id: chatId, message_ids: messageIds.slice(i, i + 100) }, botToken);
    } catch (err) {
      console.warn("[telegram-bot] deleteMessages failed (continuing):", (err as Error).message);
    }
  }
}

// ── File storage ─────────────────────────────────────────────────────────────

export type SentDocument = { messageId: number; fileId: string; fileUniqueId?: string };

type TgMessage = {
  message_id: number;
  document?: { file_id: string; file_unique_id?: string };
  audio?: { file_id: string; file_unique_id?: string };
  video?: { file_id: string; file_unique_id?: string };
};

/** Send a binary chunk as a document into a chat (silently). */
export async function sendDocumentToChat(params: {
  chatId: string | number;
  data: Buffer | Uint8Array;
  filename: string;
  mimeType?: string;
  caption?: string;
  botToken?: string | null;
  /** Whose upload this is, for the per-user fairness gate. */
  userKey?: string;
}): Promise<SentDocument> {
  const bytes = params.data instanceof Uint8Array ? params.data : new Uint8Array(params.data);

  const buildForm = () => {
    const form = new FormData();
    form.append("chat_id", String(params.chatId));
    form.append("disable_notification", "true");
    form.append("disable_content_type_detection", "true");
    if (params.caption) form.append("caption", params.caption.slice(0, 1000));
    form.append("document", new Blob([bytes as unknown as BlobPart], { type: params.mimeType || "application/octet-stream" }), params.filename);
    return form;
  };

  await acquireSendSlot(params.userKey);
  try {
    const msg = await callBotApi<TgMessage>("sendDocument", buildForm, params.botToken);
    const media = msg.document || msg.audio || msg.video;
    if (!media?.file_id) throw new BotApiError("Telegram did not return a file id.", 500);
    return { messageId: msg.message_id, fileId: media.file_id, fileUniqueId: media.file_unique_id };
  } finally {
    releaseSendSlot(params.userKey);
  }
}

/** Resolve a Bot API file_id to a short-lived download URL (valid ≥1 hour). */
export async function getBotFileDownloadUrl(fileId: string, botToken?: string | null): Promise<string> {
  const info = await callBotApi<{ file_path?: string }>("getFile", { file_id: fileId }, botToken);
  if (!info.file_path) throw new BotApiError("Telegram returned no file_path (file may exceed the 20 MB bot download limit).", 400);
  return `${API_BASE}/file/bot${token(botToken)}/${info.file_path}`;
}

/** Fetch the raw bytes of a stored file/chunk. Never expose the URL — it embeds the bot token.
 *  Retries transient CDN failures; a download that gives up mid-file would abort the
 *  whole stream for the user. */
export async function fetchBotFile(fileId: string, botToken?: string | null): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const url = await getBotFileDownloadUrl(fileId, botToken);
      const res = await fetch(url);
      if (res.ok && res.body) return res;
      // 5xx / 429 from the file CDN: back off and re-resolve (file_path expires).
      if (res.status < 500 && res.status !== 429) {
        throw new BotApiError(`Telegram file fetch failed (HTTP ${res.status}).`, res.status);
      }
      lastError = new BotApiError(`Telegram file fetch failed (HTTP ${res.status}).`, res.status);
    } catch (err) {
      if (err instanceof BotApiError && err.code >= 400 && err.code < 500 && err.code !== 429) throw err;
      lastError = err as Error;
    }
    await sleep(backoffDelay(attempt));
  }
  throw lastError ?? new BotApiError("Telegram file fetch failed.", 502);
}

// ── Setup helpers ────────────────────────────────────────────────────────────

export async function setWebhook(webhookUrl: string, secret?: string) {
  return callBotApi<boolean>("setWebhook", {
    url: webhookUrl,
    secret_token: secret || undefined,
    allowed_updates: ["message"],
    drop_pending_updates: true
  });
}

export async function getMe() {
  return callBotApi<{ id: number; username: string; first_name: string }>("getMe", {});
}

export function botConfigured() {
  return Boolean(env.BOT_TOKEN);
}
