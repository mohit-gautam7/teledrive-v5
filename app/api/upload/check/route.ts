import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { resolveOwnedFolder } from "@/lib/folder-tree";
import { prisma } from "@/lib/prisma";
import { findDuplicates, hashColumnMissing } from "@/lib/duplicates";

export const runtime = "nodejs";

/** A folder drop can be large, but not unboundedly so — this is also the cap on
 *  how much work one request can ask the database to do. */
const MAX_ENTRIES = 2000;

type Entry = { folderId?: string | null; name?: unknown; size?: unknown; hash?: unknown };

/**
 * "Which of these files do I already have?"
 *
 * Asked once, before anything is queued, so the user is prompted a single time
 * for the whole batch instead of being interrupted per file. The answer is
 * advisory: /api/upload and /api/upload/init check again at the point of writing,
 * because two tabs can both be told "no duplicates" and then both upload.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    rateLimit(`upload-check:${user.id}`, 120, 60_000);

    const { entries } = (await request.json()) as { entries?: Entry[] };
    if (!Array.isArray(entries)) {
      return NextResponse.json({ error: "entries must be an array." }, { status: 400 });
    }
    if (entries.length > MAX_ENTRIES) {
      return NextResponse.json({ error: `At most ${MAX_ENTRIES} files can be checked at once.` }, { status: 413 });
    }
    if (!entries.length) return NextResponse.json({ duplicates: [] });

    // Ownership is resolved once per distinct folder id, not once per file: a
    // folder upload repeats the same handful of destinations hundreds of times.
    const resolved = new Map<string, string | null>();
    for (const entry of entries) {
      const key = typeof entry.folderId === "string" ? entry.folderId : "";
      if (!resolved.has(key)) resolved.set(key, await resolveOwnedFolder(user.id, key || null));
    }

    const candidates = entries.map(entry => ({
      folderId: resolved.get(typeof entry.folderId === "string" ? entry.folderId : "") ?? null,
      name: String(entry.name ?? ""),
      size: Number(entry.size) || 0,
      hash: typeof entry.hash === "string" ? entry.hash : null
    }));

    const found = await findDuplicates(user.id, candidates);
    return NextResponse.json({
      duplicates: [...found].map(([index, existing]) => ({ index, ...existing })),
      // Set when this database has no contentHash column, so the client can say
      // that matching fell back to name and size rather than silently being
      // weaker than the user expects. Absent on a healthy deployment.
      ...(hashColumnMissing() ? { degraded: "contentHash" as const } : {})
    });
  } catch (error) {
    return jsonError(error, "Could not check for duplicates.");
  }
}

/**
 * Is duplicate detection actually working on this deployment?
 *
 * Open it in the browser while signed in. It exists because the failure mode
 * this feature has is *invisible*: the client treats the check as advisory, so
 * a check that cannot run at all looks exactly like a check that found nothing,
 * and the only symptom is a prompt that never appears. This answers the three
 * questions that distinguish those cases — is the route deployed at all, does
 * the database have the column, and are new uploads recording fingerprints.
 */
export async function GET() {
  try {
    const user = await requireUser();

    const stored = await prisma.file.count({
      where: { userId: user.id, isDeleted: false, uploadStatus: { not: "uploading" } }
    });

    let hashed: number | null = null;
    let contentHashColumn = true;
    try {
      hashed = await prisma.file.count({
        where: { userId: user.id, isDeleted: false, uploadStatus: { not: "uploading" }, contentHash: { not: null } }
      });
    } catch {
      // The count is the probe: if the column is missing, this is where it says so.
      contentHashColumn = false;
    }

    return NextResponse.json({
      ok: true,
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
      builtAt: process.env.NEXT_PUBLIC_BUILD_TIME ?? "unknown",
      // false means `pnpm db:sync` has not been run against this database.
      // Matching still works on name and size; renamed copies stop being caught.
      contentHashColumn,
      storedFiles: stored,
      withFingerprint: hashed,
      hint: contentHashColumn
        ? "Duplicate detection is fully enabled. If the prompt still does not appear, re-upload a file and check the browser console for '[upload] duplicate check failed'."
        : "File.contentHash is missing from this database. Run `pnpm db:sync` (or apply scripts/schema.sql) against DATABASE_URL."
    });
  } catch (error) {
    return jsonError(error, "Could not report duplicate-check status.");
  }
}
