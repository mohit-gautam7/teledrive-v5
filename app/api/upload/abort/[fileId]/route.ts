import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { purgeTelegramCopies } from "@/lib/file-delete";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";

/**
 * Discard an upload session that can never finish.
 *
 * `/api/upload/init` creates the `File` row before any bytes exist, so a failure
 * partway through leaves a row claiming the full size with no usable content.
 * The uploader calls this once it hits an error Telegram will not recover from,
 * which is why the row goes away entirely rather than into Trash — there is
 * nothing to restore.
 *
 * Deliberately *not* called on user cancel: an aborted upload stays resumable,
 * and `/api/upload/init` garbage-collects it if it is never resumed.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { fileId: string } }) {
  try {
    const user = await requireUser();

    const file = await prisma.file.findFirst({
      where: { id: params.fileId, userId: user.id, uploadStatus: "uploading" },
      include: { chunks: true, user: { include: { storageConfig: true } } }
    });
    // Already gone, or already completed — either way there is nothing to clean
    // up, and a finished file must never be deleted through this path.
    if (!file) return NextResponse.json({ ok: true, removed: false });

    // Some chunks may have landed before the failure; drop those Telegram
    // messages so the abandoned bytes do not linger in the user's chat.
    await purgeTelegramCopies(file);
    await prisma.file.delete({ where: { id: file.id } }); // chunks cascade

    return NextResponse.json({ ok: true, removed: true });
  } catch (error) {
    return jsonError(error, "Could not discard the upload session.");
  }
}
