/**
 * Telegram Bot Integration Service
 * Handles bot creation, channel management, and file uploads via Bot API
 */

import axios from "axios";

const BOT_API_URL = "https://api.telegram.org";

export interface BotCreationResult {
  token: string;
  username: string;
  botId: number;
}

export interface ChannelInfo {
  id: string;
  title: string;
  type: "private" | "public";
}

export interface FileUploadResult {
  fileId: string;
  messageId: number;
  thumbnailFileId?: string;
  size: number;
}

/**
 * Create a new Telegram bot
 */
export async function createTelegramBot(
  parentBotToken: string,
  botName: string
): Promise<BotCreationResult> {
  try {
    // In production, this would use BotFather API or admin API
    // For now, we'll return a placeholder that expects manual bot creation
    return {
      token: `${Date.now()}:${Math.random().toString(36).substring(7)}`,
      username: `teledrive_${Date.now()}_bot`,
      botId: Math.floor(Math.random() * 1000000000),
    };
  } catch (error) {
    console.error("Failed to create bot:", error);
    throw new Error("Failed to create Telegram bot");
  }
}

/**
 * Verify bot token is valid
 */
export async function verifyBotToken(botToken: string): Promise<boolean> {
  try {
    const response = await axios.get(`${BOT_API_URL}/bot${botToken}/getMe`);
    return response.data.ok === true;
  } catch (error) {
    console.error("Bot token verification failed:", error);
    return false;
  }
}

/**
 * Get bot info
 */
export async function getBotInfo(botToken: string): Promise<{
  id: number;
  username: string;
  firstName: string;
}> {
  try {
    const response = await axios.get(`${BOT_API_URL}/bot${botToken}/getMe`);
    if (!response.data.ok) {
      throw new Error("Failed to get bot info");
    }
    const bot = response.data.result;
    return {
      id: bot.id,
      username: bot.username,
      firstName: bot.first_name,
    };
  } catch (error) {
    console.error("Failed to get bot info:", error);
    throw new Error("Invalid bot token");
  }
}

/**
 * Get channel info
 */
export async function getChannelInfo(
  botToken: string,
  channelId: string
): Promise<ChannelInfo> {
  try {
    const response = await axios.post(
      `${BOT_API_URL}/bot${botToken}/getChat`,
      { chat_id: channelId }
    );

    if (!response.data.ok) {
      throw new Error("Failed to get channel info");
    }

    const chat = response.data.result;
    return {
      id: chat.id.toString(),
      title: chat.title,
      type: chat.type === "private" ? "private" : "public",
    };
  } catch (error) {
    console.error("Failed to get channel info:", error);
    throw new Error("Invalid channel ID or bot does not have access");
  }
}

/**
 * Upload image to bot channel
 */
export async function uploadImageToBot(
  botToken: string,
  channelId: string,
  imageBuffer: Buffer,
  filename: string
): Promise<FileUploadResult> {
  try {
    const formData = new FormData();
    formData.append("chat_id", channelId);
    formData.append(
      "photo",
      new Blob([new Uint8Array(imageBuffer)], { type: "image/jpeg" }),
      filename
    );

    const response = await axios.post(
      `${BOT_API_URL}/bot${botToken}/sendPhoto`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
      }
    );

    if (!response.data.ok) {
      throw new Error("Failed to upload image");
    }

    const message = response.data.result;
    const photo = message.photo[message.photo.length - 1];

    return {
      fileId: photo.file_id,
      messageId: message.message_id,
      thumbnailFileId: message.photo[0]?.file_id,
      size: imageBuffer.length,
    };
  } catch (error) {
    console.error("Failed to upload image to bot:", error);
    throw new Error("Failed to upload image to Telegram");
  }
}

/**
 * Upload document to bot channel
 */
export async function uploadDocumentToBot(
  botToken: string,
  channelId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<FileUploadResult> {
  try {
    const formData = new FormData();
    formData.append("chat_id", channelId);
    formData.append(
      "document",
      new Blob([new Uint8Array(fileBuffer)], { type: mimeType }),
      filename
    );

    const response = await axios.post(
      `${BOT_API_URL}/bot${botToken}/sendDocument`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
      }
    );

    if (!response.data.ok) {
      throw new Error("Failed to upload document");
    }

    const message = response.data.result;
    const document = message.document;

    return {
      fileId: document.file_id,
      messageId: message.message_id,
      size: fileBuffer.length,
    };
  } catch (error) {
    console.error("Failed to upload document to bot:", error);
    throw new Error("Failed to upload document to Telegram");
  }
}

/**
 * Get file download URL from bot
 */
export async function getFileDownloadUrl(
  botToken: string,
  fileId: string
): Promise<string> {
  try {
    const response = await axios.get(
      `${BOT_API_URL}/bot${botToken}/getFile?file_id=${fileId}`
    );

    if (!response.data.ok) {
      throw new Error("Failed to get file info");
    }

    const filePath = response.data.result.file_path;
    return `${BOT_API_URL}/file/bot${botToken}/${filePath}`;
  } catch (error) {
    console.error("Failed to get file download URL:", error);
    throw new Error("Failed to retrieve file from Telegram");
  }
}

/**
 * Delete message from bot channel
 */
export async function deleteMessageFromBot(
  botToken: string,
  channelId: string,
  messageId: number
): Promise<void> {
  try {
    const response = await axios.post(
      `${BOT_API_URL}/bot${botToken}/deleteMessage`,
      {
        chat_id: channelId,
        message_id: messageId,
      }
    );

    if (!response.data.ok) {
      throw new Error("Failed to delete message");
    }
  } catch (error) {
    console.error("Failed to delete message from bot:", error);
    throw new Error("Failed to delete file from Telegram");
  }
}

/**
 * Download file from Telegram
 */
export async function downloadFileFromTelegram(
  url: string
): Promise<Buffer> {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error("Failed to download file:", error);
    throw new Error("Failed to download file from Telegram");
  }
}
