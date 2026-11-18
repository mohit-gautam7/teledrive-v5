import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { MAX_ZIP_ENTRIES, planZip, ZipPlanError } from "@/lib/zip-plan";

export const runtime = "nodejs";

const requestSchema = z.object({
  folderIds: z.array(z.string()).max(50).optional(),
  fileIds: z.array(z.string()).max(MAX_ZIP_ENTRIES).optional(),
  name: z.string().max(80).optional()
});

/**
 * The list a folder download is built from — paths and sizes only, no bytes.
 *
 * The device builds the archive itself: files in the user's own Telegram are
 * read straight from Telegram, so only bot-stored files touch the file server.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const input = requestSchema.parse(await request.json());
    const { archiveName, entries, skipped } = await planZip(user.id, input.folderIds ?? [], input.fileIds ?? [], input.name);
    return NextResponse.json({
      name: archiveName,
      skipped,
      entries: entries.map(({ file, path }) => ({
        id: file.id,
        path,
        size: Number(file.size),
        modified: file.createdAt.toISOString(),
        backend: file.backend,
        telegramMessageId: file.telegramMessageId
      }))
    });
  } catch (error) {
    if (error instanceof ZipPlanError) return NextResponse.json({ error: error.message }, { status: error.status });
    return jsonError(error, "Could not list that selection.");
  }
}
