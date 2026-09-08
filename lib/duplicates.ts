import { prisma } from "@/lib/prisma";
import { STORED_ONLY } from "@/lib/upload-config";

/**
 * "Is this file already in that folder?"
 *
 * Two ways a stored file can match, and both are needed.
 *
 * The first is the content fingerprint from lib/file-identity, which is what makes a
 * renamed copy still count as the same file. The second is name-and-size, used
 * only for rows that carry no fingerprint — every file uploaded before the column
 * existed. Without that fallback the first thing a long-time user would see is
 * their entire library offering to upload itself again, and backfilling hashes
 * would mean downloading every file back out of Telegram to hash it.
 */

export type DuplicateCandidate = {
  name: string;
  size: number;
  hash?: string | null;
};

export type DuplicateMatch = { id: string; name: string; createdAt: string };

type Row = { id: string; originalName: string; size: bigint; contentHash?: string | null; createdAt: Date };

/**
 * Whether this database actually has `File.contentHash`.
 *
 * `null` until the first query has told us. A module-level cache rather than a
 * per-call probe because the answer cannot change while the process is running,
 * and asking Postgres on every upload would be a round-trip spent confirming
 * something already known.
 */
let hashColumn: boolean | null = null;

/** True once a query has proved the column is missing from this database. */
export function hashColumnMissing() {
  return hashColumn === false;
}

/**
 * Does this error mean `File.contentHash` is not in the database?
 *
 * This is the failure that took the whole feature down without a trace. The
 * column ships in prisma/schema.prisma and scripts/schema.sql, but a deployment
 * where `pnpm db:sync` was never run against the live database has the code and
 * not the column. Prisma then throws P2022 on every duplicate query,
 * /api/upload/check answers 500, and the client — which treated the check as a
 * courtesy and swallowed every error — simply never opened the prompt. Uploads
 * kept working, so nothing looked broken; the dialog just never appeared.
 */
function isMissingHashColumn(error: unknown) {
  if ((error as { code?: string })?.code === "P2022") return true;
  // The raw Postgres code for "undefined column", in case it surfaces
  // unwrapped. Paired with the column name so an unrelated 42703 is not
  // quietly downgraded into a working-but-weaker check.
  const message = String((error as Error)?.message ?? "");
  return /42703/.test(message) && /contentHash/i.test(message);
}

function matches(row: Row, candidate: DuplicateCandidate) {
  if (candidate.hash && row.contentHash) return row.contentHash === candidate.hash;
  return row.originalName === candidate.name && row.size === BigInt(candidate.size);
}

function toMatch(row: Row): DuplicateMatch {
  return { id: row.id, name: row.originalName, createdAt: row.createdAt.toISOString() };
}

/** Stored files in one folder that could match any of these candidates. */
async function candidateRows(userId: string, folderId: string | null, candidates: DuplicateCandidate[]) {
  const hashes = candidates.map(c => c.hash).filter((h): h is string => Boolean(h));
  const names = candidates.map(c => c.name);
  const sizes = candidates.map(c => BigInt(c.size));

  /**
   * The same query with and without the fingerprint column, so a database that
   * has not had the schema applied still answers on name and size instead of
   * throwing. Degrading is the right call: name-and-size is what every
   * pre-fingerprint file matches on anyway, so the prompt keeps working — it
   * just stops catching a duplicate that was renamed before being re-uploaded.
   */
  const run = (withHash: boolean) => {
    const arms: object[] = [{ originalName: { in: names }, size: { in: sizes } }];
    if (withHash && hashes.length) arms.push({ contentHash: { in: hashes } });
    return prisma.file.findMany({
      where: { userId, folderId, isDeleted: false, ...STORED_ONLY, OR: arms },
      select: {
        id: true,
        originalName: true,
        size: true,
        createdAt: true,
        ...(withHash ? { contentHash: true } : {})
      },
      // Oldest first, so the file named as "already there" is the original rather
      // than whichever copy the database happened to return first.
      orderBy: { createdAt: "asc" }
    }) as unknown as Promise<Row[]>;
  };

  if (hashColumn === false) return await run(false);

  try {
    const rows = await run(true);
    hashColumn = true;
    return rows;
  } catch (error) {
    if (!isMissingHashColumn(error)) throw error;
    hashColumn = false;
    console.warn(
      "[duplicates] File.contentHash is missing from this database — falling back to name and size. " +
        "Run `pnpm db:sync` (or apply scripts/schema.sql) to restore fingerprint matching."
    );
    return await run(false);
  }
}

/** The stored file this one duplicates, if any. */
export async function findDuplicate(
  userId: string,
  folderId: string | null,
  candidate: DuplicateCandidate
): Promise<DuplicateMatch | null> {
  const rows = await candidateRows(userId, folderId, [candidate]);
  const hit = rows.find(row => matches(row, candidate));
  return hit ? toMatch(hit) : null;
}

/**
 * The same question for a whole batch — one query per distinct folder.
 *
 * A folder upload asks about hundreds of files at once, and asking one at a time
 * would be one round-trip each.
 */
export async function findDuplicates(
  userId: string,
  entries: Array<DuplicateCandidate & { folderId: string | null }>
): Promise<Map<number, DuplicateMatch>> {
  const byFolder = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = entry.folderId ?? "";
    const bucket = byFolder.get(key);
    if (bucket) bucket.push(index);
    else byFolder.set(key, [index]);
  });

  const found = new Map<number, DuplicateMatch>();
  for (const [key, indexes] of byFolder) {
    const rows = await candidateRows(
      userId,
      key || null,
      indexes.map(i => entries[i])
    );
    if (!rows.length) continue;
    for (const index of indexes) {
      const hit = rows.find(row => matches(row, entries[index]));
      if (hit) found.set(index, toMatch(hit));
    }
  }
  return found;
}
