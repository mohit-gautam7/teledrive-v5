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
    const folders = await prisma.folder.findMany({
      where: { userId: user.id, parentId: parentId || null },
      orderBy: { name: "asc" }
    });
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
