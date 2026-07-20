import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  try {
    const user = await requireUser();
    const fileId = params.fileId;

    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: user.id, uploadStatus: "uploading", isChunked: true },
      include: { chunks: true }
    });
    if (!file) {
      return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
    }

    if (file.chunks.length < file.totalChunks) {
      return NextResponse.json(
        { error: `Incomplete: ${file.chunks.length}/${file.totalChunks} chunks received.` },
        { status: 400 }
      );
    }

    const stored = file.chunks.reduce((sum: number, c: { chunkSize: number }) => sum + c.chunkSize, 0);
    if (stored !== Number(file.size)) {
      return NextResponse.json(
        { error: `Size mismatch: stored ${stored} bytes, expected ${file.size}. Retry the upload.` },
        { status: 400 }
      );
    }

    const updated = await prisma.file.update({
      where: { id: fileId },
      data: { uploadStatus: "complete" }
    });

    return NextResponse.json({ file: toPublicFile(updated) });
  } catch (error) {
    return jsonError(error, "Could not complete upload.");
  }
}
