import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { streamFileResponse, streamInclude, readEntireFile } from "@/lib/file-stream";
import { jsonError } from "@/lib/api-response";

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

    // ── Small thumbnail for grid tiles: resize to ~400px WebP (~20-40 KB) ──────
    if (wantThumb && isImage) {
      try {
        const buf = await readEntireFile(file);
        if (buf) {
          const sharp = (await import("sharp")).default;
          const out = await sharp(buf)
            .rotate() // honor EXIF orientation
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 72 })
            .toBuffer();
          return new NextResponse(new Uint8Array(out), {
            status: 200,
            headers: { "Content-Type": "image/webp", "Cache-Control": IMMUTABLE }
          });
        }
      } catch (err) {
        console.warn("[preview] thumbnail failed, streaming full image:", (err as Error).message);
        // fall through to full stream
      }
    }

    const response = streamFileResponse(file, request.headers.get("range"), "inline");
    if (response.ok && isImage) response.headers.set("Cache-Control", IMMUTABLE);
    return response;
  } catch (error) {
    return jsonError(error, "Preview failed.");
  }
}
