import { prisma } from "@/lib/prisma";
import { safeName } from "@/lib/file-router";
import { streamInclude, unreachableReason } from "@/lib/file-stream";
import { STORED_ONLY } from "@/lib/upload-config";

/** Enough for a large personal folder; past this the archive is unwieldy anyway. */
export const MAX_ZIP_ENTRIES = 5000;

export class ZipPlanError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Which files a folder/file selection holds, and the path each one gets inside
 * the archive. Shared by the server-built zip and the device-built one, so the
 * two can never lay a folder out differently.
 *
 * Each selected folder becomes a top-level directory with its structure kept;
 * files Telegram will not serve back are left out and named in `skipped`.
 */
export async function planZip(userId: string, folderIds: string[], fileIds: string[], name?: string) {
  if (!folderIds.length && !fileIds.length) throw new ZipPlanError("Nothing was selected to download.", 400);

  // The whole tree in one query; each selection's subtree is walked in memory.
  const allFolders = await prisma.folder.findMany({ where: { userId }, select: { id: true, name: true, parentId: true } });
  const byParent = new Map<string | null, typeof allFolders>();
  for (const folder of allFolders) {
    const list = byParent.get(folder.parentId ?? null) ?? [];
    list.push(folder);
    byParent.set(folder.parentId ?? null, list);
  }
  const byId = new Map(allFolders.map(f => [f.id, f]));

  const scopes = new Map<string, string>();
  const used = new Set<string>();
  const walk = (folderId: string, prefix: string) => {
    const folder = byId.get(folderId);
    if (!folder || scopes.has(folderId)) return;
    const path = prefix ? `${prefix}/${safeName(folder.name)}` : uniqueIn(safeName(folder.name), used);
    scopes.set(folderId, path);
    for (const child of byParent.get(folderId) ?? []) walk(child.id, path);
  };
  for (const id of folderIds) walk(id, "");

  const scopedIds = [...scopes.keys()];
  const files = await prisma.file.findMany({
    where: {
      userId,
      isDeleted: false,
      ...STORED_ONLY,
      OR: [...(scopedIds.length ? [{ folderId: { in: scopedIds } }] : []), ...(fileIds.length ? [{ id: { in: fileIds } }] : [])]
    },
    include: streamInclude,
    take: MAX_ZIP_ENTRIES + 1
  });
  if (files.length > MAX_ZIP_ENTRIES) {
    throw new ZipPlanError(`That selection holds more than ${MAX_ZIP_ENTRIES} files. Download it in smaller pieces.`, 413);
  }

  const skipped: string[] = [];
  const taken = new Set<string>();
  const entries: Array<{ file: (typeof files)[number]; path: string }> = [];
  for (const file of files) {
    if (taken.has(file.id)) continue;
    taken.add(file.id);
    if (unreachableReason(file)) {
      skipped.push(file.originalName);
      continue;
    }
    const scope = file.folderId ? scopes.get(file.folderId) : undefined;
    const base = safeName(file.originalName);
    entries.push({ file, path: uniqueIn(scope ? `${scope}/${base}` : base, used) });
  }
  if (!entries.length) {
    throw new ZipPlanError(
      skipped.length
        ? "Every file in that selection is one Telegram will not serve back. Re-upload them and try again."
        : "There are no files in that selection.",
      409
    );
  }

  const archiveName = safeName(name?.trim() || defaultName(folderIds, scopes, entries.length));
  return { archiveName, entries, skipped };
}

function defaultName(folderIds: string[], scopes: Map<string, string>, count: number) {
  if (folderIds.length === 1) {
    const only = scopes.get(folderIds[0]);
    if (only) return only;
  }
  if (folderIds.length > 1) return `teledrive-${folderIds.length}-folders`;
  return `teledrive-${count}-files`;
}

/** Zip readers disagree about duplicate paths, so every path is made distinct. */
function uniqueIn(path: string, used: Set<string>) {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot > path.lastIndexOf("/") && dot !== -1 ? path.slice(0, dot) : path;
  const extension = stem === path ? "" : path.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
