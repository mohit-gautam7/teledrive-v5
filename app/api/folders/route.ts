import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { rollUpFolders } from "@/lib/folder-tree";

const folderSchema = z.object({
  name: z.string().min(1).max(80),
  parentId: z.string().nullable().optional()
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const parentId = new URL(request.url).searchParams.get("parentId");

    // Load the whole folder tree + per-folder file aggregates once, then roll
    // sizes/counts up so each folder reflects everything nested in it.
    const [allFolders, grouped] = await Promise.all([
      prisma.folder.findMany({
        where: { userId: user.id },
        select: { id: true, name: true, parentId: true, createdAt: true }
      }),
      prisma.file.groupBy({
        by: ["folderId"],
        where: { userId: user.id, isDeleted: false, folderId: { not: null } },
        _sum: { size: true },
        _count: { _all: true }
      })
    ]);

    const rolled = rollUpFolders(allFolders, grouped);
    const flat = new URL(request.url).searchParams.get("flat") === "1";
    const folders = flat ? rolled : rolled.filter(f => (f.parentId ?? null) === (parentId || null));

    return NextResponse.json({ folders });
  } catch (error) {
    return jsonError(error, "Could not load folders.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const input = folderSchema.parse(await request.json());
    const folder = await prisma.folder.create({
      data: {
        userId: user.id,
        name: input.name,
        parentId: input.parentId || null
      }
    });
    return NextResponse.json({ folder });
  } catch (error) {
    return jsonError(error, "Could not create folder.");
  }
}
