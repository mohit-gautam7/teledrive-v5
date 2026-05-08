/**
 * File Router Service
 * Determines where each file should be stored based on MIME type and size
 * Uses magic bytes for detection, falls back to extension, then size-based routing
 */

const FIFTY_MB_BYTES = 52428800; // 50 * 1024 * 1024

export type StorageMode = "botStorage" | "personalSavedMessages" | "localAgent";
export type RoutingReason =
  | "videoAlwaysPersonal"
  | "imageUnderLimit"
  | "imageOverflowToPersonal"
  | "fileUnderLimit"
  | "fileOverflowToPersonal"
  | "userOverride";

export interface RoutingDecision {
  storageMode: StorageMode;
  routingReason: RoutingReason;
  shouldNotify: boolean;
  notificationMessage?: string;
}

/**
 * Magic byte signatures for file type detection
 */
const MAGIC_BYTES = {
  // Video formats
  MP4: [0xff, 0xff, 0xff, 0xff], // ftyp box at offset 4
  WEBM: [0x1a, 0x45, 0xdf, 0xa3], // EBML header
  AVI: [0x52, 0x49, 0x46, 0x46], // RIFF header
  MOV: [0xff, 0xff, 0xff, 0xff], // ftyp box (QuickTime)
  MKV: [0x1a, 0x45, 0xdf, 0xa3], // EBML header (same as WebM)

  // Image formats
  JPEG: [0xff, 0xd8, 0xff],
  PNG: [0x89, 0x50, 0x4e, 0x47],
  GIF: [0x47, 0x49, 0x46],
  WEBP: [0x52, 0x49, 0x46, 0x46], // RIFF header
  BMP: [0x42, 0x4d],
  TIFF_LE: [0x49, 0x49, 0x2a, 0x00],
  TIFF_BE: [0x4d, 0x4d, 0x00, 0x2a],
};

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "avi",
  "mov",
  "mkv",
  "flv",
  "wmv",
  "m4v",
  "3gp",
  "ogv",
  "ts",
  "m2ts",
  "mts",
  "vob",
  "f4v",
  "asf",
  "rm",
  "rmvb",
  "divx",
]);

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "svg",
  "heic",
  "heif",
  "raw",
  "psd",
  "ai",
]);

/**
 * Detect file category from magic bytes
 */
function detectMimeTypeFromMagicBytes(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  const bytes = buffer.slice(0, 12);

  // Check for JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // Check for PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  // Check for GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }

  // Check for WebP (RIFF....WEBP)
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  // Check for BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }

  // Check for TIFF (little-endian or big-endian)
  if (
    (bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
    (bytes[0] === 0x4d &&
      bytes[1] === 0x4d &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x2a)
  ) {
    return "image/tiff";
  }

  // Check for MP4 (ftyp box at offset 4)
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }

  // Check for WebM (EBML header)
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    // Could be WebM or Matroska
    return "video/webm";
  }

  // Check for AVI (RIFF....AVI )
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x41 &&
    bytes[9] === 0x56 &&
    bytes[10] === 0x49
  ) {
    return "video/x-msvideo";
  }

  // Check for MOV (ftyp box, same as MP4 but different brand)
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    // Check for specific MOV brand codes
    const brand = bytes.slice(8, 12).toString("ascii");
    if (brand.includes("qt")) {
      return "video/quicktime";
    }
  }

  return null;
}

/**
 * Get file category from MIME type
 */
function getFileCategory(
  mimeType: string | null
): "video" | "image" | "other" {
  if (!mimeType) return "other";

  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  return "other";
}

/**
 * Get file category from extension
 */
function getFileCategoryFromExtension(
  filename: string
): "video" | "image" | "other" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

/**
 * Determine routing decision for a file
 */
export function determineRouting(
  filename: string,
  size: number,
  mimeType: string | null,
  buffer?: Buffer
): RoutingDecision {
  // Try magic bytes detection first if buffer provided
  let detectedMimeType = mimeType;
  if (buffer) {
    const magicMimeType = detectMimeTypeFromMagicBytes(buffer);
    if (magicMimeType) {
      detectedMimeType = magicMimeType;
    }
  }

  // Get file category
  let category = getFileCategory(detectedMimeType);
  if (category === "other") {
    category = getFileCategoryFromExtension(filename);
  }

  // Apply routing rules
  if (category === "video") {
    return {
      storageMode: "personalSavedMessages",
      routingReason: "videoAlwaysPersonal",
      shouldNotify: false,
    };
  }

  if (category === "image") {
    if (size <= FIFTY_MB_BYTES) {
      return {
        storageMode: "botStorage",
        routingReason: "imageUnderLimit",
        shouldNotify: false,
      };
    } else {
      return {
        storageMode: "personalSavedMessages",
        routingReason: "imageOverflowToPersonal",
        shouldNotify: true,
        notificationMessage:
          "Large image — storing in Personal Storage for better quality",
      };
    }
  }

  // Other files
  if (size <= FIFTY_MB_BYTES) {
    return {
      storageMode: "botStorage",
      routingReason: "fileUnderLimit",
      shouldNotify: false,
    };
  } else {
    return {
      storageMode: "personalSavedMessages",
      routingReason: "fileOverflowToPersonal",
      shouldNotify: true,
      notificationMessage:
        "Large file — storing in Personal Storage (up to 2GB)",
    };
  }
}

/**
 * Get human-readable explanation for routing decision
 */
export function getRoutingExplanation(decision: RoutingDecision): string {
  switch (decision.routingReason) {
    case "videoAlwaysPersonal":
      return "Videos are stored in your Personal Saved Messages because they need the larger 2GB storage limit.";
    case "imageUnderLimit":
      return "This image is stored in your Bot Channel for fast access and better organization.";
    case "imageOverflowToPersonal":
      return "This large image exceeds the 50MB bot limit, so it's stored in your Personal Saved Messages instead.";
    case "fileUnderLimit":
      return "This file is stored in your Bot Channel for convenient access.";
    case "fileOverflowToPersonal":
      return "This large file exceeds the 50MB bot limit, so it's stored in your Personal Saved Messages (up to 2GB).";
    case "userOverride":
      return "You manually chose where to store this file.";
    default:
      return "File routing determined automatically.";
  }
}

/**
 * Get storage mode display name
 */
export function getStorageModeDisplayName(mode: StorageMode): string {
  switch (mode) {
    case "botStorage":
      return "Image Storage";
    case "personalSavedMessages":
      return "Video Storage";
    case "localAgent":
      return "Local Storage";
    default:
      return "Unknown";
  }
}
