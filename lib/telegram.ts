import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { env, requireEnv } from "@/lib/env";

/**
 * LEGACY ONLY — MTProto access for files uploaded by earlier versions of
 * TeleDrive (owner's Saved Messages / personal-session uploads).
 * All new storage goes through lib/telegram-bot.ts (Bot API, per-user chat).
 */

const _clients = new Map<string, TelegramClient>();

async function getLegacyClient(sessionOverride?: string | null): Promise<TelegramClient> {
  const sessionString = sessionOverride || env.TELEGRAM_SESSION;
  if (!sessionString) {
    throw new Error(
      "This file was stored with a legacy Telegram session that is not configured. Add TELEGRAM_SESSION (or your session in Settings) to recover it."
    );
  }
  const cached = _clients.get(sessionString);
  if (cached && cached.connected) return cached;

  const apiId = Number(requireEnv("API_ID"));
  const apiHash = String(requireEnv("API_HASH"));
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3
  });
  await client.connect();
  _clients.set(sessionString, client);
  return client;
}

export function legacySessionAvailable(userSession?: string | null) {
  return Boolean(env.TELEGRAM_SESSION || userSession);
}

export async function downloadChunkFromTelegram(msgId: number, sessionOverride?: string | null): Promise<Buffer> {
  const client = await getLegacyClient(sessionOverride);
  const msgs = await client.getMessages("me", { ids: [msgId] });
  const msg = msgs[0];
  if (!msg?.media) throw new Error(`No media on message ${msgId}`);
  const data = (await client.downloadMedia(msg.media, {})) as Buffer | null;
  if (!data) throw new Error(`downloadMedia returned null for msg ${msgId}`);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export async function deleteChunkMessages(msgIds: number[], sessionOverride?: string | null): Promise<void> {
  if (!msgIds.length) return;
  try {
    const client = await getLegacyClient(sessionOverride);
    for (let i = 0; i < msgIds.length; i += 100) {
      await client.deleteMessages("me", msgIds.slice(i, i + 100), { revoke: true });
    }
  } catch (err) {
    console.error("[deleteChunkMessages] failed:", err);
  }
}
