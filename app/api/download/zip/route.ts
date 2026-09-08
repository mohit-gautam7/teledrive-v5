import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { safeName } from "@/lib/file-router";
import { streamFileResponse, streamInclude, unreachableReason } from "@/lib/file-stream";
import { zipSize, zipStream, type ZipEntry } from "@/lib/zip-stream";
import { STORED_ONLY } from "@/lib/upload-config";

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

/** Enough for a large personal folder; past this the archive is unwieldy anyway. */
const MAX_ENTRIES = 5000;

const requestSchema = z.object({
  folderIds: z.array(z.string()).max(50).optional(),
  fileIds: z.array(z.string()).max(MAX_ENTRIES).optional(),
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
    const folderIds = input.folderIds ?? [];
    const fileIds = input.fileIds ?? [];
    if (!folderIds.length && !fileIds.length) {
      return NextResponse.json({ error: "Nothing was selected to download." }, { status: 400 });
    }

    // The whole tree in one query; the subtree of each selection is walked in
    // memory rather than with a query per level.
    const allFolders = await prisma.folder.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, parentId: true }
    });
    const byParent = new Map<string | null, Array<{ id: string; name: string; parentId: string | null }>>();
    for (const folder of allFolders) {
      const key = folder.parentId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(folder);
      byParent.set(key, list);
    }
    const byId = new Map(allFolders.map(f => [f.id, f]));

    // Folder id → path inside the archive.
    const scopes = new Map<string, string>();
    const used = new Set<string>();
    const walk = (folderId: string, prefix: string) => {
      const folder = byId.get(folderId);
      if (!folder || scopes.has(folderId)) return;
      const path = prefix ? `${prefix}/${safeName(folder.name)}` : uniqueTop(safeName(folder.name), used);
      scopes.set(folderId, path);
      for (const child of byParent.get(folderId) ?? []) walk(child.id, path);
    };
    for (const id of folderIds) walk(id, "");

    const scopedIds = [...scopes.keys()];
    const files = await prisma.file.findMany({
      where: {
        userId: user.id,
        isDeleted: false,
        ...STORED_ONLY,
        OR: [
          ...(scopedIds.length ? [{ folderId: { in: scopedIds } }] : []),
          ...(fileIds.length ? [{ id: { in: fileIds } }] : [])
        ]
      },
      include: streamInclude,
      take: MAX_ENTRIES + 1
    });

    if (files.length > MAX_ENTRIES) {
      return NextResponse.json(
        { error: `That selection holds more than ${MAX_ENTRIES} files. Download it in smaller pieces.` },
        { status: 413 }
      );
    }

    // Files Telegram will not serve back would abort the archive halfway, taking
    // everything already written with them. They are left out and named in a
    // header instead, so the rest of the download still succeeds.
    const skipped: string[] = [];
    const taken = new Set<string>();
    const entries: ZipEntry[] = [];

    for (const file of files) {
      if (taken.has(file.id)) continue;
      taken.add(file.id);
      if (unreachableReason(file)) {
        skipped.push(file.originalName);
        continue;
      }
      const scope = file.folderId ? scopes.get(file.folderId) : undefined;
      const base = safeName(file.originalName);
      entries.push({
        path: uniqueIn(scope ? `${scope}/${base}` : base, used),
        size: Number(file.size),
        modified: file.createdAt,
        open: async () => {
          const response = streamFileResponse(file, null, "attachment");
          if (!response.body || response.status >= 300) {
            throw new Error(`Could not read "${file.originalName}" from Telegram.`);
          }
          return response.body as ReadableStream<Uint8Array>;
        }
      });
    }

    if (!entries.length) {
      return NextResponse.json(
        {
          error: skipped.length
            ? "Every file in that selection is one Telegram will not serve back. Re-upload them and try again."
            : "There are no files in that selection."
        },
        { status: 409 }
      );
    }

    const archiveName = safeName(input.name?.trim() || defaultName(folderIds, scopes, entries.length));
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
    return jsonError(error, "Could not build the archive.");
  }
}

function defaultName(folderIds: string[], scopes: Map<string, string>, count: number) {
  if (folderIds.length === 1) {
    const only = scopes.get(folderIds[0]);
    if (only) return only;
  }
  if (folderIds.length > 1) return `teledrive-${folderIds.length}-folders`;
  return `teledrive-${count}-files`;
}

/** Two folders called "Photos" must not become one directory in the archive. */
function uniqueTop(name: string, used: Set<string>) {
  return uniqueIn(name, used);
}

/** Zip readers disagree about duplicate paths, so every path is made distinct. */
function uniqueIn(path: string, used: Set<string>) {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot > path.lastIndexOf("/") && dot !== -1 ? path.slice(0, dot) : path;
  const extension = stem === path ? "" : path.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
