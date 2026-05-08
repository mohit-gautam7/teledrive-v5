import { describe, it, expect, vi, beforeEach } from "vitest";
import * as uploadManager from "./uploadManager";
import * as fileDb from "./fileDb";
import * as telegramBot from "./telegramBot";
import * as fileRouter from "./fileRouter";

// Mock dependencies
vi.mock("./fileDb");
vi.mock("./telegramBot");
vi.mock("./fileRouter");

describe("Upload Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processUpload", () => {
    it("should route images to bot storage", async () => {
      const jpegBuffer = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, // JPEG SOI marker
      ]);

      vi.mocked(fileRouter.determineRouting).mockReturnValue({
        storageMode: "botStorage",
        routingReason: "imageUnder50MB",
        explanation: "Image files under 50MB are stored in bot channel",
        displayName: "Image Storage",
      });

      vi.mocked(telegramBot.uploadImageToBot).mockResolvedValue({
        fileId: "test_file_id",
        messageId: 123,
        size: jpegBuffer.length,
      });

      vi.mocked(fileDb.createFile).mockResolvedValue({
        id: 1,
        userId: 1,
        name: "test.jpg",
        mimeType: "image/jpeg",
        size: jpegBuffer.length,
        folderId: undefined,
        storageMode: "botStorage",
        routingReason: "imageUnder50MB",
        userOverriddenMode: undefined,
        telegramDestination: "test_channel",
        telegramFileId: "test_file_id",
        telegramMessageId: "123",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await uploadManager.processUpload(
        {
          userId: 1,
          filename: "test.jpg",
          fileBuffer: jpegBuffer,
          mimeType: "image/jpeg",
        },
        "test_bot_token",
        "test_channel"
      );

      expect(result.storageMode).toBe("botStorage");
      expect(result.routingReason).toBe("imageUnder50MB");
      expect(telegramBot.uploadImageToBot).toHaveBeenCalled();
    });

    it("should route videos to personal storage", async () => {
      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // MP4 ftyp box
      ]);

      vi.mocked(fileRouter.determineRouting).mockReturnValue({
        storageMode: "personalSavedMessages",
        routingReason: "videoFile",
        explanation: "Video files are stored in personal saved messages",
        displayName: "Video Storage",
      });

      vi.mocked(fileDb.createFile).mockResolvedValue({
        id: 2,
        userId: 1,
        name: "test.mp4",
        mimeType: "video/mp4",
        size: mp4Buffer.length,
        folderId: undefined,
        storageMode: "personalSavedMessages",
        routingReason: "videoFile",
        userOverriddenMode: undefined,
        telegramDestination: "personal",
        telegramFileId: "personal_test",
        telegramMessageId: "msg_test",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await uploadManager.processUpload(
        {
          userId: 1,
          filename: "test.mp4",
          fileBuffer: mp4Buffer,
          mimeType: "video/mp4",
        },
        "test_bot_token",
        "test_channel"
      );

      expect(result.storageMode).toBe("personalSavedMessages");
      expect(result.routingReason).toBe("videoFile");
    });

    it("should apply user storage override", async () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      vi.mocked(fileRouter.determineRouting).mockReturnValue({
        storageMode: "botStorage",
        routingReason: "imageUnder50MB",
        explanation: "Image files under 50MB are stored in bot channel",
        displayName: "Image Storage",
      });

      vi.mocked(telegramBot.uploadImageToBot).mockResolvedValue({
        fileId: "test_file_id",
        messageId: 123,
        size: buffer.length,
      });

      vi.mocked(fileDb.createFile).mockResolvedValue({
        id: 3,
        userId: 1,
        name: "test.jpg",
        mimeType: "image/jpeg",
        size: buffer.length,
        folderId: undefined,
        storageMode: "personalSavedMessages",
        routingReason: "userOverride",
        userOverriddenMode: "personalSavedMessages",
        telegramDestination: "test_channel",
        telegramFileId: "test_file_id",
        telegramMessageId: "123",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await uploadManager.processUpload(
        {
          userId: 1,
          filename: "test.jpg",
          fileBuffer: buffer,
          mimeType: "image/jpeg",
          storageOverride: "personalSavedMessages",
        },
        "test_bot_token",
        "test_channel"
      );

      expect(result.storageMode).toBe("personalSavedMessages");
      expect(result.routingReason).toBe("userOverride");
    });

    it("should handle large files correctly", async () => {
      const largeBuffer = Buffer.alloc(100 * 1024 * 1024); // 100MB

      vi.mocked(fileRouter.determineRouting).mockReturnValue({
        storageMode: "personalSavedMessages",
        routingReason: "fileOver50MB",
        explanation: "Files over 50MB must be stored in personal storage",
        displayName: "Video Storage",
      });

      vi.mocked(fileDb.createFile).mockResolvedValue({
        id: 4,
        userId: 1,
        name: "large.bin",
        mimeType: "application/octet-stream",
        size: largeBuffer.length,
        folderId: undefined,
        storageMode: "personalSavedMessages",
        routingReason: "fileOver50MB",
        userOverriddenMode: undefined,
        telegramDestination: "personal",
        telegramFileId: "large_file_id",
        telegramMessageId: "msg_large",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await uploadManager.processUpload(
        {
          userId: 1,
          filename: "large.bin",
          fileBuffer: largeBuffer,
          mimeType: "application/octet-stream",
        },
        "test_bot_token",
        "test_channel"
      );

      expect(result.size).toBe(100 * 1024 * 1024);
      expect(result.storageMode).toBe("personalSavedMessages");
    });
  });

  describe("getFileForDownload", () => {
    it("should retrieve bot storage file download URL", async () => {
      vi.mocked(fileDb.getFile).mockResolvedValue({
        id: 1,
        userId: 1,
        name: "test.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        folderId: undefined,
        storageMode: "botStorage",
        routingReason: "imageUnder50MB",
        userOverriddenMode: undefined,
        telegramDestination: "test_channel",
        telegramFileId: "test_file_id",
        telegramMessageId: "123",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      vi.mocked(telegramBot.getFileDownloadUrl).mockResolvedValue(
        "https://api.telegram.org/file/bot123/test_file"
      );

      const result = await uploadManager.getFileForDownload(
        1,
        1,
        "test_bot_token"
      );

      expect(result.url).toBe("https://api.telegram.org/file/bot123/test_file");
      expect(result.filename).toBe("test.jpg");
      expect(result.mimeType).toBe("image/jpeg");
    });

    it("should throw error for non-existent file", async () => {
      vi.mocked(fileDb.getFile).mockResolvedValue(null);

      await expect(
        uploadManager.getFileForDownload(999, 1, "test_bot_token")
      ).rejects.toThrow("File not found");
    });
  });

  describe("deleteFile", () => {
    it("should delete file from bot storage", async () => {
      vi.mocked(fileDb.getFile).mockResolvedValue({
        id: 1,
        userId: 1,
        name: "test.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        folderId: undefined,
        storageMode: "botStorage",
        routingReason: "imageUnder50MB",
        userOverriddenMode: undefined,
        telegramDestination: "test_channel",
        telegramFileId: "test_file_id",
        telegramMessageId: "123",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      vi.mocked(telegramBot.deleteMessageFromBot).mockResolvedValue(undefined);
      vi.mocked(fileDb.deleteFile).mockResolvedValue(undefined);

      await uploadManager.deleteFile(1, 1, "test_bot_token", "test_channel");

      expect(telegramBot.deleteMessageFromBot).toHaveBeenCalledWith(
        "test_bot_token",
        "test_channel",
        123
      );
      expect(fileDb.deleteFile).toHaveBeenCalledWith(1, 1);
    });
  });
});
