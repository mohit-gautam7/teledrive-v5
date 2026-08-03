/**
 * A ZIP that is written as it is read.
 *
 * Downloading a folder must not mean buffering it: these archives are made of
 * Telegram-backed files that are individually gigabytes, so the entries are
 * streamed straight through and nothing larger than one read window is ever
 * held in memory.
 *
 * Two decisions make that possible:
 *
 *  - Entries are *stored*, not deflated. Photos and video are already
 *    compressed, so deflate would burn CPU on every byte to save almost
 *    nothing — and it would make the output size unknowable in advance.
 *  - The CRC and sizes go in a data descriptor *after* each entry (general
 *    purpose bit 3), because the CRC is only known once the bytes have gone by.
 *
 * Because stored size equals real size and the layout is fixed, the exact total
 * is computable before the first byte is written — so the response can carry a
 * real Content-Length, which is what turns "downloading…" into a percentage in
 * the transfer panel and the browser's own progress bar.
 *
 * ZIP64 is used unconditionally rather than only when something overflows 4 GB.
 * A personal drive folder crosses that line easily, and one fixed layout is both
 * simpler to reason about and the only way the size arithmetic below can be
 * guaranteed to match what the writer actually emits.
 */

export type ZipEntry = {
  /** Path inside the archive, using forward slashes. */
  path: string;
  size: number;
  modified: Date;
  /** Opened lazily, one at a time, so nothing is fetched before it is needed. */
  open: () => Promise<ReadableStream<Uint8Array>>;
};

const LOCAL_HEADER = 30;
const LOCAL_ZIP64_EXTRA = 20;
const DATA_DESCRIPTOR = 24;
const CENTRAL_HEADER = 46;
const CENTRAL_ZIP64_EXTRA = 28;
const END_RECORDS = 56 + 20 + 22;

const encoder = new TextEncoder();

/** Byte length of every entry's name, needed by both the writer and the maths. */
function nameBytes(entry: ZipEntry) {
  return encoder.encode(entry.path).length;
}

/**
 * Exactly how many bytes `zipStream` will produce for these entries.
 *
 * Kept beside the writer deliberately: if one changes, the other must, and a
 * mismatch would truncate every download with a wrong Content-Length.
 */
export function zipSize(entries: ZipEntry[]) {
  let total = 0;
  for (const entry of entries) {
    const name = nameBytes(entry);
    total += LOCAL_HEADER + name + LOCAL_ZIP64_EXTRA + entry.size + DATA_DESCRIPTOR;
    total += CENTRAL_HEADER + name + CENTRAL_ZIP64_EXTRA;
  }
  return total + END_RECORDS;
}

// ── CRC-32 ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(previous: number, bytes: Uint8Array) {
  let crc = previous ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Little-endian writers ────────────────────────────────────────────────────

class ByteWriter {
  private view: DataView;
  private offset = 0;
  readonly bytes: Uint8Array;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(value: number) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }
  u32(value: number) {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }
  u64(value: number) {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }
  raw(value: Uint8Array) {
    this.bytes.set(value, this.offset);
    this.offset += value.length;
    return this;
  }
}

/** MS-DOS date/time, which is what a ZIP entry records. */
function dosTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const STORED = 0;
/** 4.5 — the minimum version that understands ZIP64. */
const VERSION = 45;

function localHeader(entry: ZipEntry) {
  const name = encoder.encode(entry.path);
  const { time, day } = dosTime(entry.modified);
  const writer = new ByteWriter(LOCAL_HEADER + name.length + LOCAL_ZIP64_EXTRA);
  writer
    .u32(0x04034b50)
    .u16(VERSION)
    .u16(FLAGS)
    .u16(STORED)
    .u16(time)
    .u16(day)
    .u32(0) // CRC — in the data descriptor
    .u32(0xffffffff) // compressed size — see ZIP64 extra
    .u32(0xffffffff) // uncompressed size — see ZIP64 extra
    .u16(name.length)
    .u16(LOCAL_ZIP64_EXTRA)
    .raw(name)
    // ZIP64 extra: both sizes present but zero, because they are not yet known.
    .u16(0x0001)
    .u16(16)
    .u64(0)
    .u64(0);
  return writer.bytes;
}

function dataDescriptor(crc: number, size: number) {
  return new ByteWriter(DATA_DESCRIPTOR).u32(0x08074b50).u32(crc).u64(size).u64(size).bytes;
}

function centralHeader(entry: ZipEntry, crc: number, offset: number) {
  const name = encoder.encode(entry.path);
  const { time, day } = dosTime(entry.modified);
  const writer = new ByteWriter(CENTRAL_HEADER + name.length + CENTRAL_ZIP64_EXTRA);
  writer
    .u32(0x02014b50)
    .u16(VERSION) // made by
    .u16(VERSION) // needed to extract
    .u16(FLAGS)
    .u16(STORED)
    .u16(time)
    .u16(day)
    .u32(crc)
    .u32(0xffffffff) // compressed size — in the ZIP64 extra
    .u32(0xffffffff) // uncompressed size — in the ZIP64 extra
    .u16(name.length)
    .u16(CENTRAL_ZIP64_EXTRA)
    .u16(0) // comment length
    .u16(0) // disk number
    .u16(0) // internal attributes
    .u32(0) // external attributes
    .u32(0xffffffff) // local header offset — in the ZIP64 extra
    .raw(name)
    .u16(0x0001)
    .u16(24)
    .u64(entry.size)
    .u64(entry.size)
    .u64(offset);
  return writer.bytes;
}

function endRecords(count: number, centralSize: number, centralOffset: number) {
  const writer = new ByteWriter(END_RECORDS);
  writer
    // ZIP64 end of central directory
    .u32(0x06064b50)
    .u64(44) // size of this record, minus its first 12 bytes
    .u16(VERSION)
    .u16(VERSION)
    .u32(0)
    .u32(0)
    .u64(count)
    .u64(count)
    .u64(centralSize)
    .u64(centralOffset)
    // ZIP64 locator
    .u32(0x07064b50)
    .u32(0)
    .u64(centralOffset + centralSize)
    .u32(1)
    // End of central directory, with sentinels pointing at the ZIP64 record
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(Math.min(count, 0xffff))
    .u16(Math.min(count, 0xffff))
    .u32(0xffffffff)
    .u32(0xffffffff)
    .u16(0);
  return writer.bytes;
}

/**
 * Stream these entries as one archive.
 *
 * Pull-based: the next entry is only opened when the consumer has taken the
 * previous one, so a slow client throttles Telegram rather than filling memory.
 */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  let index = 0;
  let offset = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let entryCrc = 0;
  let entryWritten = 0;
  const central: Uint8Array[] = [];
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;

      // Between entries: either start the next one or close the archive.
      if (!reader) {
        if (index >= entries.length) {
          const centralOffset = offset;
          let centralSize = 0;
          for (const record of central) {
            controller.enqueue(record);
            centralSize += record.length;
          }
          controller.enqueue(endRecords(entries.length, centralSize, centralOffset));
          finished = true;
          controller.close();
          return;
        }

        const entry = entries[index];
        const header = localHeader(entry);
        central.push(centralHeader(entry, 0, offset)); // CRC patched once known
        controller.enqueue(header);
        offset += header.length;
        entryCrc = 0;
        entryWritten = 0;
        reader = (await entry.open()).getReader();
        return;
      }

      const { done, value } = await reader.read();
      if (!done && value) {
        entryCrc = crc32(entryCrc, value);
        entryWritten += value.length;
        offset += value.length;
        controller.enqueue(value);
        return;
      }

      const entry = entries[index];
      if (entryWritten !== entry.size) {
        // The Content-Length was computed from the declared size, so a short
        // read would leave the browser waiting for bytes that never come.
        throw new Error(`"${entry.path}" delivered ${entryWritten} bytes, expected ${entry.size}.`);
      }
      // Patch the CRC into the central record reserved for this entry.
      new DataView(central[index].buffer).setUint32(16, entryCrc, true);
      const descriptor = dataDescriptor(entryCrc, entry.size);
      controller.enqueue(descriptor);
      offset += descriptor.length;
      reader = null;
      index += 1;
    },
    cancel() {
      finished = true;
      void reader?.cancel().catch(() => {});
    }
  });
}
