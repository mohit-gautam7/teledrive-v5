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

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // `request` is passed so requireUser can also accept the short-lived file
    // token from `?t=`. This route is loaded directly by an <img>, a <video> or
    // a download link, which cannot set an Authorization header — and on a split
    // deployment the session cookie does not reach this origin at all.
    const user = await requireUser(request);
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
          // failOn: "none" because sharp defaults to rejecting any image with a
          // recoverable defect, and phone JPEGs are full of them — a truncated
          // EXIF block or trailing bytes after the EOI marker is routine. The
          // logs were full of "Warning treated as error due to failOn setting"
          // for files that download byte-for-byte intact and open fine
          // everywhere else. Decode what is there instead of refusing it.
          const out = await sharp(buf, { failOn: "none" })
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
        console.warn("[preview] thumbnail unavailable:", (err as Error).message);
      }

      // No thumbnail could be made — HEIC is the common case, because this
      // build of libvips has the HEIF container but no HEVC decoder.
      //
      // Falling through to the original used to "work" by streaming the whole
      // file: several megabytes per tile, for bytes no browser will render as
      // an <img>. A grid of fifty HEIC photos quietly pulled a couple of
      // hundred megabytes to draw fifty broken boxes. 415 is both honest and
      // free, and the tile shows its file-type icon instead.
      return new NextResponse(null, { status: 415, headers: protectiveHeaders() });
    }

    const response = streamFileResponse(file, request.headers.get("range"), "inline");
    if (response.ok && isImage) response.headers.set("Cache-Control", IMMUTABLE);
    return response;
  } catch (error) {
    return jsonError(error, "Preview failed.");
  }
}
