import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

const shareSchema = z.object({
  fileId: z.string(),
  expiryDate: z.string().datetime().optional().nullable(),
  password: z.string().min(4).optional().nullable()
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const input = shareSchema.parse(await request.json());
    const file = await prisma.file.findFirst({ where: { id: input.fileId, userId: user.id, isDeleted: false } });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
    const share = await prisma.share.create({
      data: {
        fileId: input.fileId,
        shareToken: nanoid(24),
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
        passwordHash: input.password ? await bcrypt.hash(input.password, 10) : null
      }
    });
    return NextResponse.json({ shareUrl: `/share/${share.shareToken}`, share });
  } catch (error) {
    return jsonError(error, "Could not create share link.");
  }
}
