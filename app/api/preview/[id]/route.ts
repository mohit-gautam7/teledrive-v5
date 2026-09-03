import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  streamFileResponse,
  streamInclude,
  readEntireFile,
  unreachableReason,
  protectiveHeaders,
  userBotToken
} from "@/lib/file-stream";
import { sendDocumentToChat, fetchBotFile } from "@/lib/telegram-bot";
import { jsonError } from "@/lib/api-response";
import { botChatFor } from "@/lib/file-router";

export const runtime = "nodejs";
export const maxDuration = 60;

// File bytes for a given id never change, so previews can cache forever.
const IMMUTABLE = "private, max-age=31536000, immutable";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const file = await prisma.file.findFirst({
      where: { id: params.id, userId: user.id, isDeleted: false },
      include: streamInclude
    });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    const wantThumb = new URL(request.url).searchParams.get("thumb") === "1";
    const isImage = (file.mimeType || "").startsWith("image/");

    // A tile renders this for every image in the folder. When the bytes are out
    // of the bot's reach the thumbnail can never be built, so say so once and
    // cheaply instead of spending a failing Telegram round-trip per render — the
    // tile falls back to its icon on any non-2xx.
    const unreachable = unreachableReason(file);
    if (unreachable) {
      return NextResponse.json(
        { error: unreachable },
        { status: 409, headers: { ...protectiveHeaders(), "Cache-Control": "no-store" } }
      );
    }

    // ── Small thumbnail for grid tiles ────────────────────────────────────────
    if (wantThumb && isImage) {
      const botToken = userBotToken(file);

      // Fast path: a thumbnail was already generated and stored in Telegram.
      if (file.thumbFileId) {
        try {
          const res = await fetchBotFile(file.thumbFileId, botToken);
          return new NextResponse(res.body, {
            status: 200,
            headers: { ...protectiveHeaders(), "Content-Type": "image/webp", "Cache-Control": IMMUTABLE }
          });
        } catch {
          // stored thumb vanished — fall through and regenerate
        }
      }

      // Slow path (once per image): download original, resize, store the thumb.
      try {
        const buf = await readEntireFile(file);
        if (buf) {
          const sharp = (await import("sharp")).default;
          const out = await sharp(buf)
            .rotate()
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 72 })
            .toBuffer();

          // Persist the thumbnail so it never has to be regenerated.
          try {
            const chatId = botChatFor(file, user.telegramId);
            const sent = await sendDocumentToChat({
              chatId,
              data: out,
              filename: `${file.id}.thumb.webp`,
              mimeType: "image/webp",
              caption: `🖼 thumb: ${file.originalName}`
            });
            await prisma.file.update({ where: { id: file.id }, data: { thumbFileId: sent.fileId } });
          } catch (err) {
            console.warn("[preview] could not persist thumb:", (err as Error).message);
          }

          return new NextResponse(new Uint8Array(out), {
            status: 200,
            headers: { ...protectiveHeaders(), "Content-Type": "image/webp", "Cache-Control": IMMUTABLE }
          });
        }
      } catch (err) {
        console.warn("[preview] thumbnail failed, streaming full image:", (err as Error).message);
      }
    }

    const response = streamFileResponse(file, request.headers.get("range"), "inline");
    if (response.ok && isImage) response.headers.set("Cache-Control", IMMUTABLE);
    return response;
  } catch (error) {
    return jsonError(error, "Preview failed.");
  }
}
