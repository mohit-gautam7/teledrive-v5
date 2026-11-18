import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { readEntireFile, streamInclude } from "@/lib/file-stream";
import { userMtprotoSession } from "@/lib/mtproto-session";
import { saveBigFileParts, finalizeBigFile, downloadRange, deleteUserMessages } from "@/lib/telegram-user";
import { MTPROTO_PART_SIZE, SAVED_MESSAGES } from "@/lib/upload-config";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Files are held in memory while they are copied; the instance has 512 MB. */
const MAX_COPY_BYTES = 64 * 1024 * 1024;

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * Copy a bot-stored file into the user's own Telegram account and switch the
 * drive row over to that copy.
 *
 * Account-stored files play and download straight from Telegram on any
 * connected device; bot-stored ones must come through the file server. The
 * copy is read back and compared byte-for-byte (SHA-256) before the row
 * changes, and the bot's copy is left exactly where it was as a backup — this
 * never deletes anything the user had.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  let session: string | null = null;
  let messageId: number | null = null;
  try {
    const user = await requireUser(request);
    const file = await prisma.file.findFirst({
      where: { id, userId: user.id, isDeleted: false, backend: "bot", uploadStatus: "complete" },
      include: streamInclude
    });
    if (!file) return NextResponse.json({ error: "No bot-stored file with that id." }, { status: 404 });

    session = await userMtprotoSession(user.id);
    if (!session) return NextResponse.json({ error: "Link your Telegram account first." }, { status: 409 });

    const original = await readEntireFile(file, MAX_COPY_BYTES);
    if (!original) return NextResponse.json({ error: "This file is too large to copy here." }, { status: 413 });
    if (original.length !== Number(file.size)) {
      return NextResponse.json({ error: `Read ${original.length} bytes, expected ${file.size}.` }, { status: 502 });
    }
    const expected = sha256(original);

    const uploadId = crypto.randomBytes(8).readBigInt64LE(0).toString();
    const totalParts = Math.ceil(original.length / MTPROTO_PART_SIZE);
    await saveBigFileParts(session, uploadId, 0, totalParts, original);
    ({ messageId } = await finalizeBigFile({
      session,
      fileId: uploadId,
      totalParts,
      fileName: file.filename,
      mimeType: file.mimeType,
      caption: `📄 ${file.originalName}`
    }));

    const copy = await downloadRange(session, messageId, 0, original.length - 1);
    if (copy.length !== original.length || sha256(copy) !== expected) {
      throw new Error("The copy in Telegram did not match the original.");
    }

    // Bot chunk rows and the bot file id stay as they are: the streaming,
    // download and delete paths address an account file by its message id only.
    const updated = await prisma.file.update({
      where: { id: file.id },
      data: {
        backend: "mtproto",
        storageMode: StorageMode.PERSONAL,
        storageChatId: SAVED_MESSAGES,
        telegramMessageId: String(messageId),
        isChunked: false
      }
    });
    return NextResponse.json({ ok: true, id: updated.id, messageId, sha256: expected });
  } catch (error) {
    // Never leave a half-made copy lying around in Saved Messages.
    if (session && messageId) await deleteUserMessages(session, [messageId]).catch(() => {});
    return jsonError(error, "Could not copy this file to your account.");
  }
}
