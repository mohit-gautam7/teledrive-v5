import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

const renameSchema = z.object({ name: z.string().min(1).max(180) });

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = renameSchema.parse(await request.json());
    const file = await prisma.file.update({
      where: { id: params.id, userId: user.id },
      data: { originalName: body.name, filename: body.name }
    });
    return NextResponse.json({ file: { ...file, size: Number(file.size) } });
  } catch (error) {
    return jsonError(error, "Could not update file.");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const file = await prisma.file.findUnique({ where: { id: params.id, userId: user.id } });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    if (file.isDeleted) {
      // Already in trash — permanently delete
      await prisma.file.delete({ where: { id: params.id } });
      return NextResponse.json({ ok: true, permanent: true });
    }

    // Move to trash (soft delete)
    await prisma.file.update({ where: { id: params.id }, data: { isDeleted: true } });
    return NextResponse.json({ ok: true, permanent: false });
  } catch (error) {
    return jsonError(error, "Could not delete file.");
  }
}
