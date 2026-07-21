import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

const folderSchema = z.object({
  name: z.string().min(1).max(80),
  parentId: z.string().nullable().optional()
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const parentId = new URL(request.url).searchParams.get("parentId");

    // Load the whole folder tree + per-folder file aggregates once, then roll
    // sizes/counts up recursively so each folder reflects everything nested in it.
    type FolderRow = { id: string; name: string; parentId: string | null; createdAt: Date };
    const [allFolders, grouped] = await Promise.all([
      prisma.folder.findMany({
        where: { userId: user.id },
        select: { id: true, name: true, parentId: true, createdAt: true }
      }) as Promise<FolderRow[]>,
      prisma.file.groupBy({
        by: ["folderId"],
        where: { userId: user.id, isDeleted: false, folderId: { not: null } },
        _sum: { size: true },
        _count: { _all: true }
      })
    ]);

    const direct = new Map<string, { size: number; count: number }>();
    for (const g of grouped) {
      if (g.folderId) direct.set(g.folderId, { size: Number(g._sum.size ?? 0), count: g._count._all });
    }

    const childrenOf = new Map<string, string[]>();
    for (const f of allFolders) {
      const key = f.parentId ?? "__root__";
      (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(f.id);
    }

    const memo = new Map<string, { size: number; count: number }>();
    const rollup = (id: string): { size: number; count: number } => {
      const cached = memo.get(id);
      if (cached) return cached;
      const own = direct.get(id) ?? { size: 0, count: 0 };
      let size = own.size;
      let count = own.count;
      for (const childId of childrenOf.get(id) ?? []) {
        const c = rollup(childId);
        size += c.size;
        count += c.count;
      }
      const result = { size, count };
      memo.set(id, result);
      return result;
    };

    const flat = new URL(request.url).searchParams.get("flat") === "1";
    const source: FolderRow[] = flat ? allFolders : allFolders.filter((f: FolderRow) => (f.parentId ?? null) === (parentId || null));

    const folders = source
      .map((f: FolderRow) => {
        const r = rollup(f.id);
        return {
          id: f.id,
          name: f.name,
          parentId: f.parentId,
          createdAt: f.createdAt,
          size: r.size,
          fileCount: r.count
        };
      })
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

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
