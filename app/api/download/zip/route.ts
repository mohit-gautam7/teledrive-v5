import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { streamFileResponse } from "@/lib/file-stream";
import { zipSize, zipStream, type ZipEntry } from "@/lib/zip-stream";
import { MAX_ZIP_ENTRIES, planZip, ZipPlanError } from "@/lib/zip-plan";

export const runtime = "nodejs";

/**
 * 300, not 3600 — and this is not a preference, it is the ceiling.
 *
 * Vercel validates `maxDuration` *after* the build, at "Deploying outputs", and
 * rejects the whole deployment when a route asks for more than the plan allows:
 * 300 s on Hobby, 800 s on Pro. The 3600 that used to be here was above every
 * plan's limit, so the build compiled cleanly and the deploy failed with a
 * generic "project or build error" and no log line naming the cause. It went in
 * with the zip feature itself and quietly broke every production deploy from
 * that commit onward — twenty-one of them — which is why features merged weeks
 * ago were never actually live.
 *
 * The archive streams, so this is a wall-clock ceiling on one response, not a
 * memory or size limit: a zip still building at five minutes is cut off. That is
 * a real limitation of serving files from a serverless function, and the reason
 * docs/DEPLOY.md moves this route to an always-on host. Raise it there, where
 * there is no cap — never above the plan's maximum here.
 */
export const maxDuration = 300;

const requestSchema = z.object({
  folderIds: z.array(z.string()).max(50).optional(),
  fileIds: z.array(z.string()).max(MAX_ZIP_ENTRIES).optional(),
  /** Archive name, without the extension. */
  name: z.string().max(80).optional()
});

/**
 * Download folders and files as one streamed archive.
 *
 * Several folders at once on purpose: picking three albums and getting three
 * separate downloads is the thing this replaces. Each selected folder becomes a
 * top-level directory inside the archive and everything nested under it comes
 * along with its structure intact.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const input = requestSchema.parse(await request.json());
    const { archiveName, entries: planned, skipped } = await planZip(user.id, input.folderIds ?? [], input.fileIds ?? [], input.name);
    const entries: ZipEntry[] = planned.map(({ file, path }) => ({
      path,
      size: Number(file.size),
      modified: file.createdAt,
      open: async () => {
        const response = streamFileResponse(file, null, "attachment");
        if (!response.body || response.status >= 300) {
          throw new Error(`Could not read "${file.originalName}" from Telegram.`);
        }
        return response.body as ReadableStream<Uint8Array>;
      }
    }));
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      // Exact, because stored entries and a fixed layout make the total
      // knowable up front — which is what gives the download a real percentage.
      "Content-Length": String(zipSize(entries)),
      "Content-Disposition": `attachment; filename="${archiveName}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Zip-Entries": String(entries.length)
    };
    if (skipped.length) {
      headers["X-Zip-Skipped"] = String(skipped.length);
      headers["X-Zip-Skipped-Names"] = encodeURIComponent(skipped.slice(0, 10).join(", "));
    }
    return new NextResponse(zipStream(entries), { status: 200, headers });
  } catch (error) {
    if (error instanceof ZipPlanError) return NextResponse.json({ error: error.message }, { status: error.status });
    return jsonError(error, "Could not build the archive.");
  }
}
