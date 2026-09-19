import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { resolveOwnedFolder } from "@/lib/folder-tree";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Guard against pathological trees and runaway copies. */
const MAX_FILES = 2000;
const MAX_FOLDERS = 500;

/**
 * Duplicate a folder and everything inside it.
 *
 * Files are copied by reference: the new rows point at the same Telegram message
 * and chunks as the originals, so nothing is re-uploaded and a copy is instant.
 *
 * Because the bytes are shared, permanently deleting one copy must not delete
 * the Telegram messages the other still needs — `purgeTelegramCopies` checks for
 * a surviving row before touching Telegram.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await requireUser();

    const source = await prisma.folder.findFirst({ where: { id: params.id, userId: user.id } });
    if (!source) return NextResponse.json({ error: "Folder not found." }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as { parentId?: string | null; name?: string };
    const destinationParent =
      body.parentId === undefined ? source.parentId : await resolveOwnedFolder(user.id, body.parentId);

    // Copying a folder into itself (or its own descendant) would recurse forever.
    const all = await prisma.folder.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, parentId: true }
    });
    if (destinationParent && isDescendant(all, destinationParent, source.id)) {
      return NextResponse.json({ error: "A folder can't be copied inside itself." }, { status: 400 });
    }

    const childrenOf = new Map<string | null, Array<{ id: string; name: string; parentId: string | null }>>();
    for (const folder of all) {
      const key = folder.parentId ?? null;
      const list = childrenOf.get(key) ?? [];
      list.push(folder);
      childrenOf.set(key, list);
    }

    const created: Array<{ id: string; name: string; parentId: string | null; createdAt: Date }> = [];
    let folderCount = 0;
    let fileCount = 0;

    const copyFolder = async (sourceId: string, name: string, parentId: string | null) => {
      if (++folderCount > MAX_FOLDERS) throw new Error("That folder tree is too large to copy.");
      const clone = await prisma.folder.create({ data: { userId: user.id, name, parentId } });
      created.push({ id: clone.id, name: clone.name, parentId: clone.parentId, createdAt: clone.createdAt });

      const files = await prisma.file.findMany({ where: { userId: user.id, folderId: sourceId, isDeleted: false } });
      if (fileCount + files.length > MAX_FILES) throw new Error("That folder holds too many files to copy.");
      fileCount += files.length;

      for (const file of files) {
        const copy = await prisma.file.create({
          data: {
            userId: user.id,
            filename: file.filename,
            originalName: file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            storageMode: file.storageMode,
            backend: file.backend,
            telegramFileId: file.telegramFileId,
            telegramMessageId: file.telegramMessageId,
            telegramFilePath: file.telegramFilePath,
            storageChatId: file.storageChatId,
            thumbFileId: file.thumbFileId,
            folderId: clone.id,
            isChunked: file.isChunked,
            totalChunks: file.totalChunks,
            uploadStatus: file.uploadStatus
          }
        });
        const chunks = await prisma.chunk.findMany({ where: { fileId: file.id } });
        if (chunks.length) {
          await prisma.chunk.createMany({
            data: chunks.map(c => ({
              fileId: copy.id,
              chunkIndex: c.chunkIndex,
              telegramMsgId: c.telegramMsgId,
              telegramFileId: c.telegramFileId,
              chunkSize: c.chunkSize
            }))
          });
        }
      }

      for (const child of childrenOf.get(sourceId) ?? []) {
        await copyFolder(child.id, child.name, clone.id);
      }
      return clone;
    };

    const root = await copyFolder(source.id, body.name?.trim() || `${source.name} copy`, destinationParent);

    return NextResponse.json({ folder: root, folders: created, folderCount, fileCount });
  } catch (error) {
    return jsonError(error, "Could not copy the folder.");
  }
}

/** True when `candidate` sits somewhere under `ancestor`. */
function isDescendant(
  all: Array<{ id: string; parentId: string | null }>,
  candidate: string,
  ancestor: string
): boolean {
  if (candidate === ancestor) return true;
  const byId = new Map(all.map(f => [f.id, f]));
  let current = byId.get(candidate)?.parentId ?? null;
  for (let guard = 0; current && guard < 100; guard++) {
    if (current === ancestor) return true;
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}
