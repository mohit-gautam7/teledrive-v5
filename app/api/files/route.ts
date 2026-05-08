import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const folderId = searchParams.get("folderId");
    const q = searchParams.get("q")?.trim();
    const view = searchParams.get("view");
    const files = await prisma.file.findMany({
      where: {
        userId: user.id,
        isDeleted: view === "trash" ? true : false,
        ...(view === "favorites" ? { isFavorite: true } : {}),
        ...(folderId && view !== "recent" ? { folderId } : view === "recent" ? {} : { folderId: null }),
        ...(q
          ? {
              OR: [
                { originalName: { contains: q, mode: "insensitive" } },
                { filename: { contains: q, mode: "insensitive" } }
              ]
            }
          : {})
      },
      orderBy: { createdAt: "desc" }
    });
    return NextResponse.json({ files: files.map(toPublicFile) });
  } catch (error) {
    return jsonError(error, "Could not load files.");
  }
}
