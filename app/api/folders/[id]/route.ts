import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

const renameSchema = z.object({ name: z.string().min(1).max(80) });

/** 404 for a folder that is not this user's — the same answer as one that does
 *  not exist, so the response cannot be used to enumerate other people's ids. */
async function requireOwnFolder(id: string, userId: string) {
  const owned = await prisma.folder.findFirst({ where: { id, userId }, select: { id: true } });
  if (!owned) throw new Response(JSON.stringify({ error: "Folder not found." }), {
    status: 404,
    headers: { "content-type": "application/json" }
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = renameSchema.parse(await request.json());
    // Ownership is confirmed before the write rather than left to the update's
    // own miss: Prisma raises P2025 for "no row matched", which jsonError can
    // only report as a 500 — so someone else's id answered with a server error
    // instead of the 404 every other route gives.
    await requireOwnFolder(params.id, user.id);
    const folder = await prisma.folder.update({
      where: { id: params.id, userId: user.id },
      data: { name: body.name }
    });
    return NextResponse.json({ folder });
  } catch (error) {
    return jsonError(error, "Could not rename folder.");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await requireOwnFolder(params.id, user.id);

    // Subfolders cascade away with the parent, but File.folder is SetNull — so
    // trashing only this folder's own files left everything nested inside it
    // loose at the root instead of in the trash. Collect the whole subtree.
    const all = await prisma.folder.findMany({
      where: { userId: user.id },
      select: { id: true, parentId: true }
    });

    const doomed = new Set([params.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of all) {
        if (folder.parentId && doomed.has(folder.parentId) && !doomed.has(folder.id)) {
          doomed.add(folder.id);
          grew = true;
        }
      }
    }

    await prisma.file.updateMany({
      where: { userId: user.id, folderId: { in: [...doomed] } },
      data: { isDeleted: true }
    });
    // Deleting the root cascades the descendants via the FolderTree relation.
    await prisma.folder.delete({ where: { id: params.id, userId: user.id } });

    return NextResponse.json({ ok: true, foldersRemoved: doomed.size });
  } catch (error) {
    return jsonError(error, "Could not delete folder.");
  }
}
