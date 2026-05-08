import { describe, it, expect } from "vitest";
import { determineRouting, getRoutingExplanation, getStorageModeDisplayName } from "./fileRouter";

describe("File Router", () => {
  describe("determineRouting", () => {
    it("should route all videos to personal storage", () => {
      const decision = determineRouting("video.mp4", 100 * 1024 * 1024, "video/mp4");
      expect(decision.storageMode).toBe("personalSavedMessages");
      expect(decision.routingReason).toBe("videoAlwaysPersonal");
      expect(decision.shouldNotify).toBe(false);
    });

    it("should route images under 50MB to bot storage", () => {
      const decision = determineRouting("photo.jpg", 10 * 1024 * 1024, "image/jpeg");
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("imageUnderLimit");
      expect(decision.shouldNotify).toBe(false);
    });

    it("should route images over 50MB to personal storage", () => {
      const decision = determineRouting("photo.jpg", 100 * 1024 * 1024, "image/jpeg");
      expect(decision.storageMode).toBe("personalSavedMessages");
      expect(decision.routingReason).toBe("imageOverflowToPersonal");
      expect(decision.shouldNotify).toBe(true);
    });

    it("should route files under 50MB to bot storage", () => {
      const decision = determineRouting("document.pdf", 20 * 1024 * 1024, "application/pdf");
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("fileUnderLimit");
      expect(decision.shouldNotify).toBe(false);
    });

    it("should route files over 50MB to personal storage", () => {
      const decision = determineRouting("archive.zip", 100 * 1024 * 1024, "application/zip");
      expect(decision.storageMode).toBe("personalSavedMessages");
      expect(decision.routingReason).toBe("fileOverflowToPersonal");
      expect(decision.shouldNotify).toBe(true);
    });

    it("should handle files at exactly 50MB boundary", () => {
      const decision = determineRouting("file.bin", 52428800, "application/octet-stream");
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("fileUnderLimit");
    });

    it("should handle files just over 50MB boundary", () => {
      const decision = determineRouting("file.bin", 52428801, "application/octet-stream");
      expect(decision.storageMode).toBe("personalSavedMessages");
      expect(decision.routingReason).toBe("fileOverflowToPersonal");
    });

    it("should detect video from extension when MIME type is missing", () => {
      const decision = determineRouting("movie.mkv", 500 * 1024 * 1024, null);
      expect(decision.storageMode).toBe("personalSavedMessages");
      expect(decision.routingReason).toBe("videoAlwaysPersonal");
    });

    it("should detect image from extension when MIME type is missing", () => {
      const decision = determineRouting("photo.png", 5 * 1024 * 1024, null);
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("imageUnderLimit");
    });

    it("should handle unknown extensions by size", () => {
      const decision = determineRouting("file.unknown", 10 * 1024 * 1024, null);
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("fileUnderLimit");
    });

    it("should detect WebM video format from magic bytes", () => {
      const buffer = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);
      const decision = determineRouting("video.webm", 100 * 1024 * 1024, null, buffer);
      expect(decision.storageMode).toBe("personalSavedMessages");
      expect(decision.routingReason).toBe("videoAlwaysPersonal");
    });

    it("should detect PNG image from magic bytes", () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const decision = determineRouting("image.png", 5 * 1024 * 1024, null, buffer);
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("imageUnderLimit");
    });

    it("should detect JPEG from magic bytes", () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const decision = determineRouting("photo.jpg", 8 * 1024 * 1024, null, buffer);
      expect(decision.storageMode).toBe("botStorage");
      expect(decision.routingReason).toBe("imageUnderLimit");
    });
  });

  describe("getRoutingExplanation", () => {
    it("should explain video routing", () => {
      const decision = determineRouting("video.mp4", 100 * 1024 * 1024, "video/mp4");
      const explanation = getRoutingExplanation(decision);
      expect(explanation).toContain("2GB");
      expect(explanation).toContain("Personal Saved Messages");
    });

    it("should explain image under limit routing", () => {
      const decision = determineRouting("photo.jpg", 10 * 1024 * 1024, "image/jpeg");
      const explanation = getRoutingExplanation(decision);
      expect(explanation).toContain("Bot Channel");
    });

    it("should explain overflow routing", () => {
      const decision = determineRouting("photo.jpg", 100 * 1024 * 1024, "image/jpeg");
      const explanation = getRoutingExplanation(decision);
      expect(explanation).toContain("50MB");
      expect(explanation).toContain("Personal Saved Messages");
    });
  });

  describe("getStorageModeDisplayName", () => {
    it("should return correct display name for bot storage", () => {
      const name = getStorageModeDisplayName("botStorage");
      expect(name).toBe("Image Storage");
    });

    it("should return correct display name for personal storage", () => {
      const name = getStorageModeDisplayName("personalSavedMessages");
      expect(name).toBe("Video Storage");
    });

    it("should return correct display name for local agent", () => {
      const name = getStorageModeDisplayName("localAgent");
      expect(name).toBe("Local Storage");
    });
  });
});
