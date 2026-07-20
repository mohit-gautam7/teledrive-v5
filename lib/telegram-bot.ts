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

async function callBotApi<T>(
  method: string,
  payload: Record<string, unknown> | FormData,
  botToken?: string | null,
  retries = 2
): Promise<T> {
  const url = `${API_BASE}/bot${token(botToken)}/${method}`;
  const isForm = payload instanceof FormData;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? payload : JSON.stringify(payload)
    });
    const body = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as BotApiEnvelope<T>;

    if (body.ok && body.result !== undefined) return body.result;

    const retryAfter = body.parameters?.retry_after;
    if (body.error_code === 429 && attempt < retries) {
      await new Promise(r => setTimeout(r, Math.min((retryAfter ?? 2) * 1000, 25_000)));
      continue;
    }
    throw new BotApiError(body.description || "Telegram Bot API error", body.error_code || res.status, retryAfter);
  }
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
}): Promise<SentDocument> {
  const form = new FormData();
  form.append("chat_id", String(params.chatId));
  form.append("disable_notification", "true");
  form.append("disable_content_type_detection", "true");
  if (params.caption) form.append("caption", params.caption.slice(0, 1000));
  const bytes = params.data instanceof Uint8Array ? params.data : new Uint8Array(params.data);
  form.append("document", new Blob([bytes as unknown as BlobPart], { type: params.mimeType || "application/octet-stream" }), params.filename);

  const msg = await callBotApi<TgMessage>("sendDocument", form, params.botToken);
  const media = msg.document || msg.audio || msg.video;
  if (!media?.file_id) throw new BotApiError("Telegram did not return a file id.", 500);
  return { messageId: msg.message_id, fileId: media.file_id, fileUniqueId: media.file_unique_id };
}

/** Resolve a Bot API file_id to a short-lived download URL (valid ≥1 hour). */
export async function getBotFileDownloadUrl(fileId: string, botToken?: string | null): Promise<string> {
  const info = await callBotApi<{ file_path?: string }>("getFile", { file_id: fileId }, botToken);
  if (!info.file_path) throw new BotApiError("Telegram returned no file_path (file may exceed the 20 MB bot download limit).", 400);
  return `${API_BASE}/file/bot${token(botToken)}/${info.file_path}`;
}

/** Fetch the raw bytes of a stored file/chunk. Never expose the URL — it embeds the bot token. */
export async function fetchBotFile(fileId: string, botToken?: string | null): Promise<Response> {
  const url = await getBotFileDownloadUrl(fileId, botToken);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new BotApiError(`Telegram file fetch failed (HTTP ${res.status}).`, res.status);
  }
  return res;
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
