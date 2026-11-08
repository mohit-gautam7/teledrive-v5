import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { aiEnabled } from "@/lib/feature-flags";
import { verifyStoredDocument } from "@/lib/telegram-user";
import { userMtprotoSession } from "@/lib/mtproto-session";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Close an upload the *browser* sent straight to Telegram.
 *
 * The relay path (/api/upload/chunk + /api/upload/complete) carries every byte
 * through this host, which is both the slow way and the expensive way — a 3 MB
 * photo costs 3 MB of the host's bandwidth twice over, once in and once out.
 * When the user has switched direct upload on, their browser does
 * saveBigFilePart and sendFile itself and arrives here with nothing but a
 * message id. That is about a kilobyte instead of the whole file.
 *
 * What this still has to do is exactly the part the client cannot be trusted
 * with: decide that the row is finished, and check that the message it names
 * is really the file it claims. See verifyStoredDocument for why a wrong id
 * would be worse than a failed upload.
 */

const body = z.object({ messageId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]) });

async function fireAutomations(userId: string, file: { id: string; originalName: string; mimeType: string }) {
  if (!aiEnabled()) return;
  try {
    const { onFileUploaded } = await import("@/lib/ai/automation");
    await onFileUploaded(userId, file);
  } catch (err) {
    console.warn("[upload/direct] automation dispatch failed (continuing):", (err as Error).message);
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params;
  try {
    const user = await requireUser();
    rateLimit(`upload-direct:${user.id}`, 600, 60_000);

    const { messageId } = body.parse(await request.json());
    const msgId = Number(messageId);

    const file = await prisma.file.findFirst({
      where: { id: params.fileId, userId: user.id, uploadStatus: "uploading", backend: "mtproto" }
    });
    if (!file) {
      return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
    }

    const config = await prisma.storageConfig.findUnique({
      where: { userId: user.id },
      select: { directUpload: true }
    });
    if (!config?.directUpload) {
      return NextResponse.json({ error: "Direct upload is switched off for this account." }, { status: 403 });
    }

    const session = await userMtprotoSession(user.id);
    if (!session) {
      return NextResponse.json({ error: "Your Telegram account is no longer linked." }, { status: 409 });
    }

    const check = await verifyStoredDocument(session, msgId, Number(file.size));
    if (!check.ok) {
      // Leave the session open: /api/upload/init hands it back and the browser
      // retries, either directly or down the relay path.
      console.warn("[upload/direct] rejected message", msgId, "-", check.reason);
      return NextResponse.json(
        { error: `Telegram does not have that file where the browser said it did. ${check.reason}` },
        { status: 409 }
      );
    }

    const updated = await prisma.file.update({
      where: { id: file.id },
      data: {
        uploadStatus: "complete",
        telegramMessageId: String(msgId),
        // The bytes are one message now, not a ledger of parts.
        isChunked: false
      }
    });
    // A direct upload never wrote chunk rows, but a fallback or a resumed
    // relay attempt may have left some behind.
    await prisma.chunk.deleteMany({ where: { fileId: file.id } });
    await fireAutomations(user.id, updated);

    return NextResponse.json({ file: toPublicFile(updated) });
  } catch (error) {
    return jsonError(error, "Could not finish the direct upload.");
  }
}
