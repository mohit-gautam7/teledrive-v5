import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const body = await request.json().catch(() => ({}));
  const share = await prisma.share.findUnique({
    where: { shareToken: params.token },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: { file: true, folder: true } as any
  });
  if (!share || share.disabled) {
    return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = share as any;
  if (s.file && s.file.isDeleted) {
    return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
  }
  if (share.expiryDate && share.expiryDate < new Date()) {
    return NextResponse.json({ error: "Share link expired." }, { status: 410 });
  }
  if (share.passwordHash) {
    const ok = body.password && (await bcrypt.compare(body.password, share.passwordHash));
    if (!ok) return NextResponse.json({ passwordRequired: true }, { status: 401 });
  }

  // Folder share — return folder info + files list
  if (s.folderId && s.folder) {
    const files = await prisma.file.findMany({
      where: { folderId: s.folderId, isDeleted: false },
      orderBy: { createdAt: "desc" }
    });
    return NextResponse.json({
      folder: { id: s.folder.id, name: s.folder.name },
      files: files.map(f => toPublicFile(f))
    });
  }

  // File share
  if (!s.file) return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
  return NextResponse.json({ file: toPublicFile(s.file) });
}
