import { prisma } from "@/lib/prisma";
import { sendMessageBot } from "@/lib/telegram-bot";
import { safeName } from "@/lib/file-router";
import { StorageMode } from "@prisma/client";

/**
 * Shared handling for Telegram updates — used by both the production webhook
 * route and the local dev polling loop, so behavior never diverges.
 */

export type TelegramUpdate = {
  message?: TgIncomingMessage;
  edited_message?: TgIncomingMessage;
};

type TgIncomingMessage = {
  from?: { id?: number; first_name?: string; last_name?: string; username?: string };
  chat?: { id?: number; type?: string };
  text?: string;
  document?: TgFilePayload & { file_name?: string; mime_type?: string };
  video?: TgFilePayload & { file_name?: string; mime_type?: string };
  audio?: TgFilePayload & { file_name?: string; mime_type?: string };
  voice?: TgFilePayload & { mime_type?: string };
  photo?: TgFilePayload[];
};

type TgFilePayload = { file_id: string; file_size?: number };

function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function upsertUser(telegramId: string, name: string, username: string | null) {
  return prisma.user.upsert({
    where: { telegramId },
    update: { name, username },
    create: { telegramId, name, username }
  });
}

async function issueLoginCode(telegramId: string, name: string, username: string | null) {
  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.botLoginCode.updateMany({
    where: { telegramId, used: false },
    data: { used: true }
  });
  await prisma.botLoginCode.create({ data: { telegramId, name, username, code, expiresAt } });
  return code;
}

function pickIncomingFile(message: TgIncomingMessage) {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      name: message.document.file_name || "document",
      mime: message.document.mime_type || "application/octet-stream",
      size: message.document.file_size || 0
    };
  }
  if (message.video) {
    return {
      fileId: message.video.file_id,
      name: message.video.file_name || `video_${Date.now()}.mp4`,
      mime: message.video.mime_type || "video/mp4",
      size: message.video.file_size || 0
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      name: message.audio.file_name || `audio_${Date.now()}.mp3`,
      mime: message.audio.mime_type || "audio/mpeg",
      size: message.audio.file_size || 0
    };
  }
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      name: `voice_${Date.now()}.ogg`,
      mime: message.voice.mime_type || "audio/ogg",
      size: message.voice.file_size || 0
    };
  }
  if (message.photo?.length) {
    const best = message.photo[message.photo.length - 1];
    return {
      fileId: best.file_id,
      name: `photo_${Date.now()}.jpg`,
      mime: "image/jpeg",
      size: best.file_size || 0
    };
  }
  return null;
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (!message?.from?.id || !message.chat?.id || message.chat.type !== "private") return;

  const chatId = String(message.chat.id);
  const telegramId = String(message.from.id);
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "User";
  const username = message.from.username ?? null;

  // ── A file sent to the bot → save it straight into the sender's drive ──────
  const incoming = pickIncomingFile(message);
  if (incoming) {
    const user = await upsertUser(telegramId, name, username);
    const record = await prisma.file.create({
      data: {
        userId: user.id,
        filename: safeName(incoming.name),
        originalName: incoming.name,
        mimeType: incoming.mime,
        size: BigInt(incoming.size),
        storageMode: StorageMode.BOT,
        storageChatId: chatId,
        isChunked: true,
        totalChunks: 1,
        uploadStatus: "complete",
        chunks: {
          create: { chunkIndex: 0, telegramMsgId: 0, telegramFileId: incoming.fileId, chunkSize: incoming.size }
        }
      }
    });
    const overLimit = incoming.size > 20 * 1024 * 1024;
    await sendMessageBot(
      chatId,
      overLimit
        ? `✅ "${record.originalName}" saved to your TeleDrive.\n⚠️ Files over 20 MB sent this way can't be downloaded back through the site (Telegram bot limit) — upload big files on the site instead.`
        : `✅ "${record.originalName}" saved to your TeleDrive. It will appear on the site instantly.`
    );
    return;
  }

  // ── Any text (/start, /login, anything) → issue a login code ───────────────
  await upsertUser(telegramId, name, username);
  const code = await issueLoginCode(telegramId, name, username);
  const isStart = (message.text || "").startsWith("/start");
  const safeDisplayName = name.replace(/[_*`\[\]]/g, "");
  await sendMessageBot(
    chatId,
    (isStart
      ? `👋 Welcome to TeleDrive, ${safeDisplayName}!\n\nYour files are stored here in this chat — in *your* Telegram, under your control.\n\n`
      : "") +
      `🔑 *Login code*\n\n\`${code}\`\n\nEnter it on the TeleDrive site. Valid for 10 minutes — don't share it.\n\n💡 Tip: send me any file and it lands in your drive.`,
    { parse_mode: "Markdown" }
  );
}
