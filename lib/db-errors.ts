/**
 * Recognising a database failure, without importing the database.
 *
 * Deliberately dependency-free: both `lib/prisma` (to decide what to retry) and
 * `lib/api-response` (to decide what to report) need this, and importing either
 * from the other would drag the Prisma client — or the Telegram client — into
 * bundles that only wanted to classify an error.
 */

/** Prisma's own error code, when this is a Prisma failure. */
export function prismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (typeof name !== "string" || !name.startsWith("PrismaClient")) return null;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : name;
}

/**
 * P2024 (pool timeout), P1001/P1002 (unreachable), P1008 (operation timeout) and
 * P1017 (server closed the connection) are all "the database is busy, try
 * again" rather than a fault in the request. Left unmapped they became a bare
 * 500 — which is what the drive showed every time the search box asked for a
 * listing the local cache had never seen.
 */
const TRANSIENT_DB_CODES = new Set(["P2024", "P1001", "P1002", "P1008", "P1017", "PrismaClientInitializationError"]);

export function isTransientDbError(error: unknown) {
  const code = prismaErrorCode(error);
  return code !== null && TRANSIENT_DB_CODES.has(code);
}
