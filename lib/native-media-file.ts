/** A lazy File: only requested Telegram parts cross the native bridge. */
export type NativeMedia = { id: string; name: string; size: number; type: string; lastModified: number;
  /** The album's own destination; older app builds leave it out. */
  folderId?: string };
type ReadPart = (offset: number, length: number) => Promise<string>;
const MAX_PART = 512 * 1024;

class MediaSlice extends Blob {
  constructor(privateOffset: number, privateLength: number, read: ReadPart, type = "") {
    super([], { type });
    this.offset = privateOffset;
    this.length = privateLength;
    this.read = read;
  }
  private offset: number;
  private length: number;
  private read: ReadPart;
  override get size() { return this.length; }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    if (!this.length) return new ArrayBuffer(0);
    if (this.length > MAX_PART) throw new Error("Native backup must read bounded Telegram parts.");
    const raw = atob(await this.read(this.offset, this.length));
    if (raw.length !== this.length) throw new Error("The phone returned an incomplete file part.");
    return Uint8Array.from(raw, char => char.charCodeAt(0)).buffer;
  }
}

export class NativeMediaFile extends File {
  private mediaSize: number;
  private read: ReadPart;
  constructor(media: NativeMedia, read: ReadPart) {
    super([], media.name, { type: media.type, lastModified: media.lastModified });
    this.mediaSize = media.size;
    this.read = read;
  }
  override get size() { return this.mediaSize; }
  override slice(start = 0, end = this.size, type = ""): Blob {
    const clamp = (value: number) => Math.max(0, Math.min(this.size, value < 0 ? this.size + value : value));
    const from = clamp(start), to = clamp(end);
    return new MediaSlice(from, Math.max(0, to - from), this.read, type);
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error("Read native backup files in parts, not into a whole-file buffer.");
  }
}
