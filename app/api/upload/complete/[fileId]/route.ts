import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";

/**
 * Let any matching automation rule queue itself now the bytes are really
 * stored. Gated on the flag and deliberately non-fatal: the upload has already
 * succeeded, and a rule failing must never turn that into an error.
 */
async function fireAutomations(userId: string, file: { id: string; originalName: string; mimeType: string }) {
  if (!aiEnabled()) return;
  try {
    const { onFileUploaded } = await import("@/lib/ai/automation");
    await onFileUploaded(userId, file);
  } catch (err) {
    console.warn("[upload/complete] automation dispatch failed (continuing):", (err as Error).message);
  }
}
import { finalizeBigFile } from "@/lib/telegram-user";
import { userMtprotoSession } from "@/lib/mtproto-session";
import { MTPROTO_PART_SIZE } from "@/lib/upload-config";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params;
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

    // MTProto: the parts are on Telegram's servers but not yet a message. Turn
    // them into one document in the user's Saved Messages.
    if (file.backend === "mtproto") {
      const session = await userMtprotoSession(user.id);
      if (!session) {
        return NextResponse.json(
          { error: "Your Telegram account is no longer linked, so this upload can't be finalised." },
          { status: 409 }
        );
      }
      if (!file.telegramFileId) {
        return NextResponse.json({ error: "Upload session is missing its Telegram file id." }, { status: 500 });
      }
      let messageId: number | string;
      try {
        ({ messageId } = await finalizeBigFile({
          session,
          fileId: file.telegramFileId,
          totalParts: Math.ceil(Number(file.size) / MTPROTO_PART_SIZE),
          fileName: file.filename,
          mimeType: file.mimeType,
          caption: `📄 ${file.originalName}`
        }));
      } catch (error) {
        // Telegram would not assemble the parts — almost always because it has
        // expired the ones sent hours ago. Dropping the chunk ledger is what makes
        // the retry a real retry: /api/upload/init hands the session back with
        // nothing received, so the file is sent again in full rather than resuming
        // onto parts that are no longer there and finalising something truncated.
        await prisma.chunk.deleteMany({ where: { fileId } });
        console.warn("[upload/complete] mtproto finalise failed:", (error as Error).message);
        return NextResponse.json(
          { error: "Telegram could not assemble this upload — it has to be sent again. Retry to start it over." },
          { status: 409 }
        );
      }
      const updated = await prisma.file.update({
        where: { id: fileId },
        data: {
          uploadStatus: "complete",
          telegramMessageId: String(messageId),
          // Bytes now live in one message, not in per-chunk records.
          isChunked: false
        }
      });
      await prisma.chunk.deleteMany({ where: { fileId } });
      await fireAutomations(user.id, updated);
      return NextResponse.json({ file: toPublicFile(updated) });
    }

    const updated = await prisma.file.update({
      where: { id: fileId },
      data: { uploadStatus: "complete" }
    });

    await fireAutomations(user.id, updated);
    return NextResponse.json({ file: toPublicFile(updated) });
  } catch (error) {
    return jsonError(error, "Could not complete upload.");
  }
}
