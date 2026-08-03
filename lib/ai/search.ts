import { prisma } from "@/lib/prisma";
import { runEmbed } from "@/lib/ai/router";
import { resolvePlan } from "@/lib/ai/modes";
import { extractIndexableText } from "@/lib/ai/file-tasks";
import { streamInclude } from "@/lib/file-stream";
import { toPublicFile } from "@/lib/file-router";

/**
 * Semantic search over the text of a user's files.
 *
 * Vectors live in JSONB and similarity is computed here rather than in the
 * database, because pgvector is not enabled on this Supabase project. For a
 * personal drive that is the right trade: an exact scan is more accurate than an
 * approximate index and stays under a few hundred milliseconds into the low tens
 * of thousands of chunks. Past that it wants pgvector — see docs/AI.md.
 */

/** Slices are overlapped so a sentence spanning a boundary is still findable. */
const CHUNK_CHARS = 1_200;
const CHUNK_OVERLAP = 150;
/** One embedding request per file, to keep provider round-trips down. */
const MAX_CHUNKS_PER_FILE = 40;

export function sliceText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  for (let i = 0; i < clean.length && out.length < MAX_CHUNKS_PER_FILE; i += CHUNK_CHARS - CHUNK_OVERLAP) {
    out.push(clean.slice(i, i + CHUNK_CHARS));
  }
  return out;
}

export function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Embed one file's text and replace whatever was indexed for it before. */
export async function indexFile(userId: string, fileId: string) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId, isDeleted: false, uploadStatus: { not: "uploading" } },
    include: streamInclude
  });
  if (!file) throw new Error("The file no longer exists.");

  const text = await extractIndexableText(file);
  if (!text) return { indexed: 0, reason: "no extractable text" };

  const chunks = sliceText(text);
  if (!chunks.length) return { indexed: 0, reason: "empty" };

  const plan = await resolvePlan(userId, "embed");
  const { vectors, model } = await runEmbed({
    userId,
    task: "embed",
    inputs: chunks,
    providers: plan.providers,
    strategy: plan.strategy,
    localOnly: plan.localOnly,
    freeOnly: plan.freeOnly
  });

  // Replace rather than merge: a re-index of a changed file must not leave
  // stale slices behind that would still match a search.
  await prisma.fileEmbedding.deleteMany({ where: { fileId } });
  await prisma.fileEmbedding.createMany({
    data: chunks.map((chunk, i) => ({
      userId,
      fileId,
      chunkIndex: i,
      text: chunk,
      vector: vectors[i] as never,
      model
    }))
  });

  return { indexed: chunks.length, model };
}

export type SearchHit = {
  fileId: string;
  fileName: string;
  score: number;
  excerpt: string;
};

/**
 * A hit, plus the file record the drive needs to draw it.
 *
 * Semantic results used to be a list of names in Settings, where a name was
 * enough. On the main page they are files: they open, download, share and carry
 * a menu like any other tile, so the listing shape travels with the hit rather
 * than costing the browser a second lookup per result.
 */
export type SearchResult = SearchHit & { file: PublicFile };

type PublicFile = ReturnType<typeof toPublicFile>;

export async function semanticSearchWithFiles(userId: string, query: string, limit = 10): Promise<SearchResult[]> {
  const hits = await semanticSearch(userId, query, limit);
  if (!hits.length) return [];

  const files = await prisma.file.findMany({ where: { id: { in: hits.map(h => h.fileId) }, userId } });
  const byId = new Map(files.map(f => [f.id, toPublicFile(f)]));

  // A hit whose file has vanished between the scan and this read is dropped
  // rather than rendered as a tile with nothing behind it.
  return hits.flatMap(hit => {
    const file = byId.get(hit.fileId);
    return file ? [{ ...hit, file }] : [];
  });
}

export async function semanticSearch(userId: string, query: string, limit = 10): Promise<SearchHit[]> {
  const rows = await prisma.fileEmbedding.findMany({
    where: { userId },
    select: { fileId: true, text: true, vector: true, file: { select: { originalName: true, isDeleted: true } } }
  });
  if (!rows.length) return [];

  const plan = await resolvePlan(userId, "embed");
  const { vectors } = await runEmbed({
    userId,
    task: "embed",
    inputs: [query],
    providers: plan.providers,
    strategy: plan.strategy,
    localOnly: plan.localOnly,
    freeOnly: plan.freeOnly
  });
  const queryVector = vectors[0];

  const scored = rows
    // A trashed file's slices stay in the table so restoring it does not lose
    // the index, but they must not surface in results.
    .filter(r => !r.file.isDeleted)
    .map(r => ({
      fileId: r.fileId,
      fileName: r.file.originalName,
      excerpt: r.text.slice(0, 240),
      score: cosine(queryVector, (r.vector as number[]) ?? [])
    }))
    .sort((a, b) => b.score - a.score);

  // One hit per file — several slices of the same document are one result to a
  // person, not five.
  const seen = new Set<string>();
  const best: SearchHit[] = [];
  for (const hit of scored) {
    if (seen.has(hit.fileId)) continue;
    seen.add(hit.fileId);
    best.push(hit);
    if (best.length >= limit) break;
  }
  return best;
}
