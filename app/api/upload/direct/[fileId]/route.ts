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
import { DIRECT_MAX_BYTES } from "@/lib/direct-parts";
import type { File } from "@prisma/client";

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

const messageIdSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);
const body = z.union([
  z.object({ messageId: messageIdSchema }),
  // A file past one message: one id per DIRECT_MAX_BYTES piece, in order.
  z.object({ messageIds: z.array(messageIdSchema).min(2).max(1000) })
]);

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

    const parsed = body.parse(await request.json());

    const file = await prisma.file.findFirst({
      where: { id: params.fileId, userId: user.id, isDeleted: false, backend: "mtproto" }
    });
    if (!file) {
      return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
    }
    if ("messageIds" in parsed) return confirmSplit(user.id, file, parsed.messageIds.map(Number));
    const msgId = Number(parsed.messageId);
    // A lost response must not make a successful confirmation look like failure.
    if (file.uploadStatus === "complete" && file.telegramMessageId === String(msgId)) {
      return NextResponse.json({ file: toPublicFile(file) });
    }
    if (file.uploadStatus !== "uploading") {
      return NextResponse.json({ error: "Upload session is already closed." }, { status: 409 });
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

    // Uses its own short-lived connection, closed right after, so the key is
    // never left open here and concurrent confirmations cannot close each other's.
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

/**
 * Finish a file stored as several messages. Every piece is checked against the
 * size it must have, the same rule as a single message, before anything is
 * written. The pieces become Chunk rows; telegramMessageId stays empty so no
 * single-message path can mistake piece one for the whole file.
 */
async function confirmSplit(userId: string, file: File, msgIds: number[]) {
  const size = Number(file.size);
  const expected = Math.ceil(size / DIRECT_MAX_BYTES);
  if (new Set(msgIds).size !== msgIds.length) {
    return NextResponse.json({ error: "The same Telegram message was named as two parts." }, { status: 400 });
  }
  if (msgIds.length !== expected) {
    return NextResponse.json({ error: `This file needs ${expected} parts, but ${msgIds.length} were sent.` }, { status: 400 });
  }
  const sizes = msgIds.map((_, i) => Math.min(DIRECT_MAX_BYTES, size - i * DIRECT_MAX_BYTES));

  const stored = await prisma.chunk.findMany({ where: { fileId: file.id }, orderBy: { chunkIndex: "asc" } });
  if (file.uploadStatus === "complete" && stored.map(c => c.telegramMsgId).join() === msgIds.join()) {
    return NextResponse.json({ file: toPublicFile(file) });
  }
  if (file.uploadStatus !== "uploading") {
    return NextResponse.json({ error: "Upload session is already closed." }, { status: 409 });
  }
  const config = await prisma.storageConfig.findUnique({ where: { userId }, select: { directUpload: true } });
  if (!config?.directUpload) {
    return NextResponse.json({ error: "Direct upload is switched off for this account." }, { status: 403 });
  }
  const session = await userMtprotoSession(userId);
  if (!session) return NextResponse.json({ error: "Your Telegram account is no longer linked." }, { status: 409 });

  // Each check opens its own short connection, so they can run side by side
  // and a 5-part file still fits in one function's time limit.
  const checks = await Promise.all(msgIds.map((id, i) => verifyStoredDocument(session, id, sizes[i])));
  const bad = checks.findIndex(check => !check.ok);
  if (bad >= 0) {
    const reason = (checks[bad] as { reason?: string }).reason ?? "";
    console.warn("[upload/direct] rejected part", bad + 1, "message", msgIds[bad], "-", reason);
    return NextResponse.json(
      { error: `Telegram does not have part ${bad + 1} where the browser said it did. ${reason}` },
      { status: 409 }
    );
  }

  const [, , updated] = await prisma.$transaction([
    prisma.chunk.deleteMany({ where: { fileId: file.id } }),
    prisma.chunk.createMany({
      data: msgIds.map((id, i) => ({ fileId: file.id, chunkIndex: i, telegramMsgId: id, telegramFileId: null, chunkSize: sizes[i] }))
    }),
    prisma.file.update({
      where: { id: file.id },
      data: { uploadStatus: "complete", telegramMessageId: null, isChunked: true, totalChunks: msgIds.length }
    })
  ]);
  await fireAutomations(userId, updated);
  return NextResponse.json({ file: toPublicFile(updated) });
}
