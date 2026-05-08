import TelegramBot from "node-telegram-bot-api";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { env, requireEnv } from "@/lib/env";

export async function uploadWithBot(file: File, botToken?: string | null, channelId?: string | null) {
  const token = botToken || env.BOT_TOKEN;
  const chatId = channelId || env.BOT_CHANNEL_ID;
  if (!token || !chatId) {
    throw new Error("Bot token and channel id are required for bot storage.");
  }
  const bot = new TelegramBot(token);
  const bytes = Buffer.from(await file.arrayBuffer());
  const message = await bot.sendDocument(
    chatId,
    bytes,
    {},
    {
      filename: file.name,
      contentType: file.type || "application/octet-stream"
    }
  );
  const document = message.document;
  return {
    fileId: document?.file_id,
    messageId: String(message.message_id),
    filePath: undefined
  };
}

export async function getBotFileUrl(fileId: string, botToken?: string | null) {
  const token = botToken || env.BOT_TOKEN;
  if (!token) throw new Error("Bot token is required.");
  const bot = new TelegramBot(token);
  return bot.getFileLink(fileId);
}

async function createTelegramClient(session?: string | null) {
  const apiId = Number(requireEnv("API_ID"));
  const apiHash = String(requireEnv("API_HASH"));
  const sessionString = session || env.TELEGRAM_SESSION;
  if (!sessionString) {
    throw new Error("TELEGRAM_SESSION is required for personal storage uploads.");
  }
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3
  });
  await client.connect();
  return client;
}

export async function uploadWithPersonalTelegram(file: File, session?: string | null) {
  const client = await createTelegramClient(session);
  const bytes = Buffer.from(await file.arrayBuffer());
  const customFile = new CustomFile(file.name, bytes.length, file.name, bytes);
  const uploaded = await client.uploadFile({ file: customFile, workers: 1 });
  const result = await client.invoke(
    new Api.messages.SendMedia({
      peer: "me",
      media: new Api.InputMediaUploadedDocument({
        file: uploaded,
        mimeType: file.type || "application/octet-stream",
        attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })]
      }),
      message: file.name,
      randomId: Date.now() as never
    })
  );
  const update = Array.isArray((result as { updates?: unknown[] }).updates)
    ? ((result as { updates: Array<{ message?: { id?: number } }> }).updates.find(item => item.message?.id))
    : undefined;
  return { messageId: update?.message?.id ? String(update.message.id) : undefined };
}
