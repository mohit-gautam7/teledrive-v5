/**
 * Upload Queue Service
 * Manages async file uploads using BullMQ with separate queues for images and videos
 */

import { Queue, Worker } from "bullmq";
import * as uploadManager from "./uploadManager";

// Queue configuration
const queueConfig = {
  connection: {
    host: "localhost",
    port: 6379,
  },
};

// Create separate queues for different file types
export const imageUploadQueue = new Queue("image-uploads", queueConfig);
export const videoUploadQueue = new Queue("video-uploads", queueConfig);

export interface UploadJobData {
  userId: number;
  filename: string;
  fileBuffer: Buffer;
  mimeType?: string;
  folderId?: number;
  storageOverride?: "botStorage" | "personalSavedMessages";
  botToken: string;
  botChannelId: string;
}

/**
 * Add file to upload queue
 */
export async function queueUpload(
  data: UploadJobData,
  priority: "high" | "normal" | "low" = "normal"
): Promise<string> {
  try {
    // Determine which queue based on file type
    const isVideo = data.mimeType?.startsWith("video/");
    const queue = isVideo ? videoUploadQueue : imageUploadQueue;

    // Add job to queue
    const job = await queue.add("upload", data, {
      priority: priority === "high" ? 10 : priority === "low" ? 1 : 5,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });

    return job.id || "";
  } catch (error) {
    console.error("Failed to queue upload:", error);
    throw new Error("Failed to queue upload");
  }
}

/**
 * Get upload job status
 */
export async function getUploadStatus(jobId: string): Promise<{
  status: "pending" | "active" | "completed" | "failed";
  progress?: number;
  error?: string;
}> {
  try {
    // Check both queues
    const imageJob = await imageUploadQueue.getJob(jobId);
    const videoJob = await videoUploadQueue.getJob(jobId);
    const job = imageJob || videoJob;

    if (!job) {
      return { status: "failed", error: "Job not found" };
    }

    const state = await job.getState();
    const progress = job.progress;

    return {
      status: (state as any) || "pending",
      progress: typeof progress === "number" ? progress : undefined,
    };
  } catch (error) {
    console.error("Failed to get upload status:", error);
    return { status: "failed", error: "Failed to get status" };
  }
}

/**
 * Initialize upload workers
 */
export function initializeUploadWorkers() {
  // Image upload worker
  const imageWorker = new Worker("image-uploads", imageUploadHandler, {
    connection: queueConfig.connection,
    concurrency: 3,
  });

  // Video upload worker
  const videoWorker = new Worker("video-uploads", videoUploadHandler, {
    connection: queueConfig.connection,
    concurrency: 2,
  });

  // Setup event handlers
  setupWorkerEvents(imageWorker, "image");
  setupWorkerEvents(videoWorker, "video");

  console.log("[Upload Queue] Workers initialized");

  return { imageWorker, videoWorker };
}

/**
 * Image upload handler
 */
async function imageUploadHandler(job: any) {
  try {
    const data: UploadJobData = job.data;

    // Process upload
    const result = await uploadManager.processUpload(
      {
        userId: data.userId,
        filename: data.filename,
        fileBuffer: data.fileBuffer,
        mimeType: data.mimeType,
        folderId: data.folderId,
        storageOverride: data.storageOverride,
      },
      data.botToken,
      data.botChannelId
    );

    return result;
  } catch (error) {
    console.error("Image upload failed:", error);
    throw error;
  }
}

/**
 * Video upload handler
 */
async function videoUploadHandler(job: any) {
  try {
    const data: UploadJobData = job.data;

    // Process upload
    const result = await uploadManager.processUpload(
      {
        userId: data.userId,
        filename: data.filename,
        fileBuffer: data.fileBuffer,
        mimeType: data.mimeType,
        folderId: data.folderId,
        storageOverride: data.storageOverride,
      },
      data.botToken,
      data.botChannelId
    );

    return result;
  } catch (error) {
    console.error("Video upload failed:", error);
    throw error;
  }
}

/**
 * Setup worker event handlers
 */
function setupWorkerEvents(worker: Worker, type: string) {
  worker.on("completed", (job: any) => {
    console.log(`[${type.toUpperCase()} Upload] Job ${job.id} completed`);
  });

  worker.on("failed", (job: any, err: any) => {
    console.error(
      `[${type.toUpperCase()} Upload] Job ${job?.id} failed:`,
      err.message
    );
  });

  worker.on("error", (err: any) => {
    console.error(`[${type.toUpperCase()} Upload] Worker error:`, err);
  });
}

/**
 * Cleanup queues
 */
export async function cleanupQueues() {
  try {
    await imageUploadQueue.close();
    await videoUploadQueue.close();
    console.log("[Upload Queue] Queues cleaned up");
  } catch (error) {
    console.error("Failed to cleanup queues:", error);
  }
}
