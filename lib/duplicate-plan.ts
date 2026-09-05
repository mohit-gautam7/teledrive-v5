/**
 * What to do with a batch once the user has answered the duplicate prompt.
 *
 * Split out of the drive so it is a plain function over plain data: given the
 * files that were picked, the ones the server already has, and one choice per
 * duplicate, it says exactly what to upload and what to list as skipped. That
 * makes the rule checkable without a browser (scripts/check-dedupe.mjs) — and
 * this is a rule worth checking, because getting it wrong means either a file
 * uploaded twice or a file the user asked for silently not uploaded at all.
 *
 * Imports nothing on purpose; keep it that way.
 */

/** What to do with one file that is already in its destination folder. */
export type DuplicateChoice = "skip" | "replace" | "copy";

/**
 * One file, ready to queue.
 *
 * `destination` is already a real folder id: the folder chain a directory upload
 * implies is created once, up front, before anything is queued.
 */
export type QueuedUpload = {
  file: File;
  destination: string | null;
  path?: string;
  contentHash?: string | null;
  allowDuplicate?: boolean;
  replaceFileId?: string;
};

/** A duplicate the user chose to skip — listed, not silently dropped. */
export type SkippedUpload = {
  name: string;
  size: number;
  duplicateOf: { id: string; name: string };
};

/** What /api/upload/check says about one file in the batch. */
export type DuplicateHit = { index: number; id: string; name: string };

/**
 * Split a batch into what to send and what to skip.
 *
 * A file with no duplicate is queued untouched — in particular *without*
 * `allowDuplicate`, so the server's own check still stands behind it. Only files
 * the user was actually shown and chose to send get permission to override it.
 */
export function planBatch(
  batch: QueuedUpload[],
  duplicates: DuplicateHit[],
  choices: Record<number, DuplicateChoice>
): { queue: QueuedUpload[]; skipped: SkippedUpload[] } {
  const byIndex = new Map(duplicates.map(entry => [entry.index, entry]));
  const queue: QueuedUpload[] = [];
  const skipped: SkippedUpload[] = [];

  batch.forEach((item, index) => {
    const existing = byIndex.get(index);
    if (!existing) {
      queue.push(item);
      return;
    }
    // Skip is the default for anything unanswered: it is the only choice that
    // cannot lose a file or store one twice.
    const choice = choices[index] ?? "skip";
    if (choice === "skip") {
      skipped.push({
        name: item.file.name,
        size: item.file.size,
        duplicateOf: { id: existing.id, name: existing.name }
      });
      return;
    }
    queue.push({
      ...item,
      allowDuplicate: true,
      // Replace deletes the old copy only once the new one is stored, so a failed
      // upload can never be the reason a file disappeared.
      replaceFileId: choice === "replace" ? existing.id : undefined
    });
  });

  return { queue, skipped };
}

/**
 * Collapse files that duplicate each other *within* one batch.
 *
 * The server cannot see these — the second copy would arrive after the first was
 * stored — so dropping the same file dragged in twice is the client's job.
 */
export function dedupeBatch(batch: QueuedUpload[]): QueuedUpload[] {
  const seen = new Set<string>();
  return batch.filter(entry => {
    const identity = entry.contentHash ?? `${entry.file.name}|${entry.file.size}`;
    const key = `${entry.destination ?? ""}|${identity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
