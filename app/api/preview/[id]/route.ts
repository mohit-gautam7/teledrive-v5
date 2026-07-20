import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { streamFileResponse, streamInclude } from "@/lib/file-stream";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const file = await prisma.file.findFirst({
      where: { id: params.id, userId: user.id, isDeleted: false },
      include: streamInclude
    });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    const response = streamFileResponse(file, request.headers.get("range"), "inline");
    if (response.ok) response.headers.set("Cache-Control", "private, max-age=300");
    return response;
  } catch (error) {
    return jsonError(error, "Preview failed.");
  }
}
