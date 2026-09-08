import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { streamFileResponse, streamInclude } from "@/lib/file-stream";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
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

    return streamFileResponse(file, request.headers.get("range"), "inline");
  } catch (error) {
    return jsonError(error, "Streaming failed.");
  }
}
