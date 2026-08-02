/** A file plus the folder path it should be filed under, relative to the drop target. */
export type PickedFile = { file: File; path?: string };

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void };
};

function readEntry(entry: FileSystemEntryLike, prefix: string): Promise<PickedFile[]> {
  if (entry.isFile) {
    return new Promise<PickedFile[]>(resolve => {
      entry.file?.(
        file => resolve([{ file, path: prefix ? `${prefix}/${file.name}` : file.name }]),
        () => resolve([])
      );
    });
  }
  if (!entry.isDirectory || !entry.createReader) return Promise.resolve([]);

  const reader = entry.createReader();
  const nested = prefix ? `${prefix}/${entry.name}` : entry.name;

  // readEntries returns at most ~100 entries per call and must be drained.
  return new Promise<PickedFile[]>(resolve => {
    const collected: PickedFile[] = [];
    const readBatch = () => {
      reader.readEntries(
        async entries => {
          if (!entries.length) {
            resolve(collected);
            return;
          }
          for (const child of entries) collected.push(...(await readEntry(child, nested)));
          readBatch();
        },
        () => resolve(collected)
      );
    };
    readBatch();
  });
}

/**
 * Flatten a drop into files, walking directories so dropping a folder preserves
 * its structure.
 *
 * `dataTransfer.files` alone reports a dropped directory as a single zero-byte
 * entry, so folder drops silently uploaded nothing. The entry API is the only
 * way to see inside, and it must be read synchronously during the drop event —
 * hence the entries are captured before any await.
 */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FileSystemEntryLike[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
    const entry = typeof getEntry === "function" ? getEntry.call(item) : null;
    if (entry) entries.push(entry as FileSystemEntryLike);
  }

  if (!entries.length) {
    // Browser without the entry API: plain files still work, folders can't.
    return Array.from(dataTransfer.files ?? []).map(file => ({ file }));
  }

  const results = await Promise.all(entries.map(entry => readEntry(entry, "")));
  return results.flat();
}

/** Files chosen through an <input>, carrying webkitRelativePath when present. */
export function filesFromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? []).map(file => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined
  }));
}
