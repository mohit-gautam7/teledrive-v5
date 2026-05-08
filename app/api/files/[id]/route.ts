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
    await prisma.file.update({
      where: { id: params.id, userId: user.id },
      data: { isDeleted: true }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not delete file.");
  }
}
