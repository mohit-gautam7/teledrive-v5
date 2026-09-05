import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { resolveOwnedFolder } from "@/lib/folder-tree";
import { findDuplicates } from "@/lib/duplicates";

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
      duplicates: [...found].map(([index, existing]) => ({ index, ...existing }))
    });
  } catch (error) {
    return jsonError(error, "Could not check for duplicates.");
  }
}
