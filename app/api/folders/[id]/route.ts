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
    // Soft-delete all files inside the folder (move to trash)
    await prisma.file.updateMany({
      where: { folderId: params.id, userId: user.id },
      data: { isDeleted: true }
    });
    // Delete the folder itself
    await prisma.folder.delete({ where: { id: params.id, userId: user.id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not delete folder.");
  }
}
