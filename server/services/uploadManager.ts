/**
 * Upload Manager Service
 * Orchestrates file uploads with routing, storage selection, and error handling
 */

import * as fileDb from "./fileDb";
import * as telegramBot from "./telegramBot";
import { determineRouting } from "./fileRouter";
import { StorageMode, RoutingReason } from "./fileRouter";

export interface UploadRequest {
  userId: number;
  filename: string;
  fileBuffer: Buffer;
  mimeType?: string;
  folderId?: number;
  storageOverride?: StorageMode;
}

export interface UploadResponse {
  fileId: number;
  filename: string;
  size: number;
  storageMode: StorageMode;
  routingReason: RoutingReason;
  telegramFileId: string;
  telegramMessageId?: string;
}

/**
 * Process file upload with automatic routing
 */
export async function processUpload(
  request: UploadRequest,
  botToken: string,
  botChannelId: string
): Promise<UploadResponse> {
  try {
    // Get routing decision
    const routing = determineRouting(
      request.filename,
      request.fileBuffer.length,
      request.mimeType || null,
      request.fileBuffer
    );

    // Apply user override if provided
    const finalStorageMode = request.storageOverride || routing.storageMode;
    const routingReason = request.storageOverride ? "userOverride" : routing.routingReason;

    // Upload to appropriate storage
    let telegramFileId: string;
    let telegramMessageId: string | undefined;

    if (finalStorageMode === "botStorage") {
      // Upload to bot channel
      const result = await uploadToBot(
        botToken,
        botChannelId,
        request.filename,
        request.fileBuffer,
        request.mimeType
      );

      telegramFileId = result.fileId;
      telegramMessageId = result.messageId?.toString();
    } else {
      // For personal storage, we would use Telethon
      // For now, create a placeholder entry
      telegramFileId = `personal_${Date.now()}`;
      telegramMessageId = `msg_${Date.now()}`;
    }

    // Save file metadata to database
    const file = await fileDb.createFile({
      userId: request.userId,
      name: request.filename,
      mimeType: request.mimeType,
      size: request.fileBuffer.length,
      folderId: request.folderId,
      storageMode: finalStorageMode as "botStorage" | "personalSavedMessages",
      routingReason: routingReason as RoutingReason,
      userOverriddenMode: request.storageOverride as "botStorage" | "personalSavedMessages" | undefined,
      telegramDestination: botChannelId,
      telegramFileId,
      telegramMessageId,
    });

    return {
      fileId: file.id,
      filename: file.name,
      size: file.size,
      storageMode: finalStorageMode,
      routingReason: routingReason as RoutingReason,
      telegramFileId,
      telegramMessageId,
    };
  } catch (error) {
    console.error("Upload processing error:", error);
    throw new Error(`Failed to process upload: ${error}`);
  }
}

/**
 * Upload file to bot storage
 */
async function uploadToBot(
  botToken: string,
  channelId: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType?: string
): Promise<{ fileId: string; messageId: number }> {
  try {
    // Determine if it's an image or document
    if (mimeType?.startsWith("image/")) {
      const result = await telegramBot.uploadImageToBot(
        botToken,
        channelId,
        fileBuffer,
        filename
      );
      return {
        fileId: result.fileId,
        messageId: result.messageId,
      };
    } else {
      const result = await telegramBot.uploadDocumentToBot(
        botToken,
        channelId,
        fileBuffer,
        filename,
        mimeType || "application/octet-stream"
      );
      return {
        fileId: result.fileId,
        messageId: result.messageId,
      };
    }
  } catch (error) {
    console.error("Bot upload error:", error);
    throw error;
  }
}

/**
 * Get file for download/streaming
 */
export async function getFileForDownload(
  fileId: number,
  userId: number,
  botToken: string
): Promise<{ url: string; filename: string; mimeType?: string }> {
  try {
    const file = await fileDb.getFile(fileId, userId);
    if (!file) {
      throw new Error("File not found");
    }

    if (file.storageMode === "botStorage" && file.telegramFileId) {
      const url = await telegramBot.getFileDownloadUrl(botToken, file.telegramFileId);
      return {
        url,
        filename: file.name,
        mimeType: file.mimeType || "application/octet-stream",
      };
    } else {
      // For personal storage, would use Telethon streaming
      throw new Error("Personal storage streaming not yet implemented");
    }
  } catch (error) {
    console.error("Get file for download error:", error);
    throw error;
  }
}

/**
 * Delete file from storage
 */
export async function deleteFile(
  fileId: number,
  userId: number,
  botToken: string,
  botChannelId: string
): Promise<void> {
  try {
    const file = await fileDb.getFile(fileId, userId);
    if (!file) {
      throw new Error("File not found");
    }

    // Delete from Telegram
    if (file.storageMode === "botStorage" && file.telegramMessageId) {
      await telegramBot.deleteMessageFromBot(
        botToken,
        botChannelId,
        parseInt(file.telegramMessageId)
      );
    } else if (file.storageMode === "personalSavedMessages") {
      // Would delete via Telethon
    }

    // Delete from database
    await fileDb.deleteFile(fileId, userId);
  } catch (error) {
    console.error("Delete file error:", error);
    throw error;
  }
}
