import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

const renameSchema = z.object({ name: z.string().min(1).max(80) });

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = renameSchema.parse(await request.json());
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
