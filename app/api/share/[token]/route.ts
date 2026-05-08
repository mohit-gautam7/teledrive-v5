import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const body = await request.json().catch(() => ({}));
  const share = await prisma.share.findUnique({
    where: { shareToken: params.token },
    include: { file: true }
  });
  if (!share || share.disabled || share.file.isDeleted) {
    return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
  }
  if (share.expiryDate && share.expiryDate < new Date()) {
    return NextResponse.json({ error: "Share link expired." }, { status: 410 });
  }
  if (share.passwordHash) {
    const ok = body.password && (await bcrypt.compare(body.password, share.passwordHash));
    if (!ok) return NextResponse.json({ passwordRequired: true }, { status: 401 });
  }
  return NextResponse.json({ file: toPublicFile(share.file) });
}
