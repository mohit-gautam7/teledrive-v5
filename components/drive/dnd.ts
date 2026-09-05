import { resumeKeyFor } from "@/lib/file-identity";
import {
  directoryKey,
  handleFromDataTransferItem,
  rememberHandle,
  type StoredDirectoryHandle
} from "@/lib/upload-store";

/** A file plus the folder path it should be filed under, relative to the drop target. */
export type PickedFile = { file: File; path?: string };

/**
 * Keep a durable handle for everything dropped, so an upload interrupted by a
 * reload can pick the bytes back up on its own.
 *
 * A dropped file is remembered under its own resume key. A dropped *directory*
 * is remembered once, under its name, and individual files are resolved out of
 * it later by walking their relative path — the alternative, which is what this
 * did before, was to discard directory handles entirely and make a folder upload
 * unresumable.
 *
 * Best-effort by design: only Chromium exposes `getAsFileSystemHandle`.
 * Everywhere else the transfer panel falls back to a Resume button that re-picks
 * the file by hand, so nothing here is allowed to fail an upload — hence the
 * silent catch.
 */
export async function rememberDroppedHandles(items: DataTransferItem[]): Promise<void> {
  await Promise.all(
    items.map(async item => {
      try {
        const handle = await handleFromDataTransferItem(item);
        if (!handle) return;
        if (handle.kind === "directory") {
          await rememberHandle(directoryKey(handle.name), handle);
          return;
        }
        await rememberHandle(resumeKeyFor(await handle.getFile()), handle);
      } catch {
        /* no handle available — the manual Resume path covers it */
      }
    })
  );
}

/**
 * Walk a directory the user picked through `showDirectoryPicker`.
 *
 * The `webkitdirectory` input works everywhere but hands back plain `File`s and
 * no handle, so a folder picked that way can never auto-resume. Where the picker
 * exists this path is used instead, and the handle it returns is remembered the
 * same way a dropped folder's is.
 */
export async function filesFromDirectoryHandle(root: StoredDirectoryHandle): Promise<PickedFile[]> {
  await rememberHandle(directoryKey(root.name), root);
  const out: PickedFile[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    for await (const entry of (dir as FileSystemDirectoryHandle & {
      values: () => AsyncIterable<FileSystemHandle>;
    }).values()) {
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "file") out.push({ file: await (entry as FileSystemFileHandle).getFile(), path });
      else await walk(entry as FileSystemDirectoryHandle, path);
    }
  };
  await walk(root, root.name);
  return out;
}

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
