/**
 * Storage Adapter Layer
 * Abstracts Bot API and Telethon connections for unified file operations
 */

import axios from "axios";

export interface StorageAdapterConfig {
  botToken?: string;
  telegramApiId?: string;
  telegramApiHash?: string;
  telegramSession?: string;
}

export interface UploadResult {
  fileId: string;
  messageId?: string;
  thumbnailUrl?: string;
  size: number;
}

export interface DownloadResult {
  url: string;
  expiresAt?: Date;
}

/**
 * Bot Storage Adapter
 * Handles uploads and downloads via Telegram Bot API
 */
export class BotStorageAdapter {
  private botToken: string;
  private botApiUrl = "https://api.telegram.org";

  constructor(botToken: string) {
    if (!botToken) {
      throw new Error("Bot token is required");
    }
    this.botToken = botToken;
  }

  /**
   * Upload file to bot channel
   */
  async uploadFile(
    channelId: string,
    fileBuffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<UploadResult> {
    try {
      const formData = new FormData();
      formData.append("chat_id", channelId);

      // Determine file type and upload accordingly
      if (mimeType.startsWith("image/")) {
        formData.append("photo", new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), filename);
        const response = await axios.post(
          `${this.botApiUrl}/bot${this.botToken}/sendPhoto`,
          formData,
          { headers: { "Content-Type": "multipart/form-data" } }
        );

        const data = response.data.result;
        const photo = data.photo[data.photo.length - 1];

        return {
          fileId: photo.file_id,
          messageId: data.message_id.toString(),
          thumbnailUrl: data.photo[0]?.file_id,
          size: fileBuffer.length,
        };
      } else {
        formData.append("document", new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), filename);
        const response = await axios.post(
          `${this.botApiUrl}/bot${this.botToken}/sendDocument`,
          formData,
          { headers: { "Content-Type": "multipart/form-data" } }
        );

        const data = response.data.result;
        return {
          fileId: data.document.file_id,
          messageId: data.message_id.toString(),
          size: fileBuffer.length,
        };
      }
    } catch (error) {
      console.error("Bot storage upload error:", error);
      throw new Error(`Failed to upload file to bot storage: ${error}`);
    }
  }

  /**
   * Get download URL for file from bot
   */
  async getDownloadUrl(fileId: string): Promise<DownloadResult> {
    try {
      const response = await axios.get(
        `${this.botApiUrl}/bot${this.botToken}/getFile?file_id=${fileId}`
      );

      if (!response.data.ok) {
        throw new Error("Failed to get file info from bot");
      }

      const filePath = response.data.result.file_path;
      const url = `${this.botApiUrl}/file/bot${this.botToken}/${filePath}`;

      // Bot API URLs expire after ~1 hour
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1);

      return { url, expiresAt };
    } catch (error) {
      console.error("Bot storage download error:", error);
      throw new Error(`Failed to get download URL: ${error}`);
    }
  }

  /**
   * Delete file from bot channel
   */
  async deleteFile(messageId: string, channelId: string): Promise<void> {
    try {
      await axios.post(
        `${this.botApiUrl}/bot${this.botToken}/deleteMessage`,
        {
          chat_id: channelId,
          message_id: parseInt(messageId),
        }
      );
    } catch (error) {
      console.error("Bot storage delete error:", error);
      throw new Error(`Failed to delete file from bot storage: ${error}`);
    }
  }
}

/**
 * Personal Storage Adapter
 * Handles uploads and downloads via Telethon (personal account)
 * Note: This is a placeholder - actual Telethon integration requires Python or node-telethon
 */
export class PersonalStorageAdapter {
  private sessionData: string;
  private apiId: string;
  private apiHash: string;

  constructor(sessionData: string, apiId: string, apiHash: string) {
    this.sessionData = sessionData;
    this.apiId = apiId;
    this.apiHash = apiHash;
  }

  /**
   * Upload file to personal saved messages
   * In production, this would use Telethon client
   */
  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<UploadResult> {
    try {
      // Placeholder for Telethon integration
      // In production, initialize Telethon client with sessionData
      // and upload file to saved messages

      return {
        fileId: `personal_${Date.now()}`,
        messageId: `msg_${Date.now()}`,
        size: fileBuffer.length,
      };
    } catch (error) {
      console.error("Personal storage upload error:", error);
      throw new Error(`Failed to upload file to personal storage: ${error}`);
    }
  }

  /**
   * Stream file from personal storage
   */
  async streamFile(
    messageId: string,
    range?: { start: number; end: number }
  ): Promise<{ data: Buffer; contentType: string; contentLength: number }> {
    try {
      // Placeholder for Telethon streaming
      // In production, initialize Telethon client and stream file chunks

      return {
        data: Buffer.alloc(0),
        contentType: "application/octet-stream",
        contentLength: 0,
      };
    } catch (error) {
      console.error("Personal storage stream error:", error);
      throw new Error(`Failed to stream file: ${error}`);
    }
  }

  /**
   * Delete file from personal storage
   */
  async deleteFile(messageId: string): Promise<void> {
    try {
      // Placeholder for Telethon delete
      // In production, initialize Telethon client and delete message
    } catch (error) {
      console.error("Personal storage delete error:", error);
      throw new Error(`Failed to delete file from personal storage: ${error}`);
    }
  }

  /**
   * Validate session
   */
  async validateSession(): Promise<boolean> {
    try {
      // Placeholder for session validation
      // In production, try to connect with Telethon client
      return true;
    } catch (error) {
      console.error("Session validation error:", error);
      return false;
    }
  }
}

/**
 * Create appropriate storage adapter based on storage mode
 */
export function createStorageAdapter(
  mode: "botStorage" | "personalSavedMessages",
  config: StorageAdapterConfig
): BotStorageAdapter | PersonalStorageAdapter {
  if (mode === "botStorage") {
    if (!config.botToken) {
      throw new Error("Bot token required for bot storage");
    }
    return new BotStorageAdapter(config.botToken);
  } else {
    if (!config.telegramSession || !config.telegramApiId || !config.telegramApiHash) {
      throw new Error("Session data and API credentials required for personal storage");
    }
    return new PersonalStorageAdapter(
      config.telegramSession,
      config.telegramApiId,
      config.telegramApiHash
    );
  }
}
