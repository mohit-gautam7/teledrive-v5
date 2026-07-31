import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";

const PAGE_SIZE = 48;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const folderId = searchParams.get("folderId");
    const q = searchParams.get("q")?.trim();
    const view = searchParams.get("view");
    const type = searchParams.get("type"); // image | video | doc

    const take = Math.min(Number(searchParams.get("take")) || PAGE_SIZE, MAX_PAGE_SIZE);
    const skip = Math.max(Number(searchParams.get("skip")) || 0, 0);

    const dir = searchParams.get("dir") === "asc" ? "asc" : "desc";
    const sortField = searchParams.get("sort");
    const orderBy =
      sortField === "name"
        ? { originalName: dir as "asc" | "desc" }
        : sortField === "size"
          ? { size: dir as "asc" | "desc" }
          : { createdAt: dir as "asc" | "desc" };

    // Trash, Favourites and Recent are cross-folder collections; only the
    // regular file browser is scoped to one folder. Without this, anything
    // trashed or starred while inside a folder is invisible in those views.
    const spansFolders = view === "trash" || view === "favorites" || view === "recent";

    const where = {
      userId: user.id,
      isDeleted: view === "trash" ? true : false,
      ...(view === "favorites" ? { isFavorite: true } : {}),
      ...(spansFolders ? {} : { folderId: folderId || null }),
      ...(type === "image"
        ? { mimeType: { startsWith: "image/" } }
        : type === "video"
          ? { mimeType: { startsWith: "video/" } }
          : type === "doc"
            ? { NOT: [{ mimeType: { startsWith: "image/" } }, { mimeType: { startsWith: "video/" } }] }
            : {}),
      ...(q
        ? {
            OR: [
              { originalName: { contains: q, mode: "insensitive" as const } },
              { filename: { contains: q, mode: "insensitive" as const } }
            ]
          }
        : {})
    };

    // take + 1 so we know whether another page exists without a COUNT query.
    const rows = await prisma.file.findMany({
      where,
      orderBy,
      skip,
      take: take + 1
    });

    const hasMore = rows.length > take;
    const files = (hasMore ? rows.slice(0, take) : rows).map(toPublicFile);

    return NextResponse.json({ files, hasMore, nextSkip: skip + files.length });
  } catch (error) {
    return jsonError(error, "Could not load files.");
  }
}
