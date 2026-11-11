export const DIRECT_PART_SIZE = 512 * 1024;
export const DIRECT_MAX_BYTES = 4000 * DIRECT_PART_SIZE;

/** Keep only two slices in memory; GramJS's File uploader buffers the whole file. */
export async function uploadDirectParts(
  file: Blob,
  send: (index: number, bytes: Buffer, count: number) => Promise<boolean>,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
  beforeSend?: () => Promise<void>
) {
  if (file.size <= 0 || file.size > DIRECT_MAX_BYTES) throw new Error("File exceeds the supported direct-upload size (4000 × 512 KiB parts), or is empty.");
  const { Buffer } = await import("buffer");
  const count = Math.ceil(file.size / DIRECT_PART_SIZE);
  let cursor = 0;
  let completed = 0;
  let failed = false;
  const checkAbort = () => { if (signal?.aborted) throw new DOMException("Upload paused or cancelled", "AbortError"); };
  const worker = async () => {
    try {
      while (!failed) {
        checkAbort();
        await beforeSend?.();
        const index = cursor++;
        if (index >= count) return;
        const bytes = Buffer.from(await file.slice(index * DIRECT_PART_SIZE, (index + 1) * DIRECT_PART_SIZE).arrayBuffer());
        checkAbort();
        if (failed) return;
        if (!await send(index, bytes, count)) throw new Error("Telegram did not accept an upload part.");
        completed += bytes.length;
        onProgress(Math.min(completed, file.size - 1));
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, count) }, worker));
  const error = results.find(result => result.status === "rejected");
  if (error?.status === "rejected") throw error.reason;
  checkAbort();
  return count;
}
