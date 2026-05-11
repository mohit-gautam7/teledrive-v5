import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

const commonFields = {
  expiryDate: z.string().datetime().optional().nullable(),
  password: z.string().min(4).optional().nullable()
};

const shareSchema = z.union([
  z.object({ fileId: z.string(), folderId: z.undefined().optional(), ...commonFields }),
  z.object({ folderId: z.string(), fileId: z.undefined().optional(), ...commonFields })
]);

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const input = shareSchema.parse(await request.json());
    const shareData: Record<string, unknown> = {
      shareToken: nanoid(24),
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
      passwordHash: input.password ? await bcrypt.hash(input.password, 10) : null
    };

    if (input.folderId) {
      const folder = await prisma.folder.findFirst({ where: { id: input.folderId, userId: user.id } });
      if (!folder) return NextResponse.json({ error: "Folder not found." }, { status: 404 });
      shareData.folderId = input.folderId;
    } else {
      const file = await prisma.file.findFirst({ where: { id: input.fileId, userId: user.id, isDeleted: false } });
      if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
      shareData.fileId = input.fileId;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const share = await prisma.share.create({ data: shareData as any });
    return NextResponse.json({ shareUrl: `/share/${share.shareToken}`, share });
  } catch (error) {
    return jsonError(error, "Could not create share link.");
  }
}
