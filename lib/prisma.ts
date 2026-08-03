import { PrismaClient } from "@prisma/client";
import { isTransientDbError } from "@/lib/db-errors";

/**
 * One PrismaClient for the whole process — in production too.
 *
 * The cache used to be guarded by `NODE_ENV !== "production"`, which is the
 * advice for a single-bundle server. It is wrong here. Next builds every route
 * handler into its own bundle, so `lib/prisma` is *instantiated once per
 * bundle*: a production build of this app contains 32 copies of
 * `new PrismaClient()` (every `app/api/**` route, both pages, and the job
 * worker's chunk). Each one opens its own pool, so `connection_limit=1` in the
 * Supabase pooler URL did not mean "one connection" — it meant "one per route",
 * up to 32 at once.
 *
 * That is what made the drive fail intermittently with a 500 once AI was
 * switched on: `JOB_WORKER_ENABLED=1` adds a 33rd client that polls the Job
 * table forever, and the pooler starts queueing or refusing new clients. The
 * search box was simply where it showed: every keystroke is a cache key nothing
 * has stored, so it always hits the network and always surfaces the toast, while
 * ordinary navigation is painted from localStorage and swallows the same error.
 *
 * Assigning the global unconditionally makes all 32 bundles share one client and
 * one pool. It also still does what the dev-only version did: survive HMR.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * How many connections that one shared pool may open.
 *
 * With a client per route, a limit of 1 was a way to stop 32 pools swamping the
 * pooler. Sharing one client makes it counterproductive instead: every query in
 * the process would serialise behind a single connection, which is exactly why
 * the AI overview's nine parallel queries took ~7.6 s. Five is a deliberate
 * middle — enough that a page's concurrent requests overlap, low enough to stay
 * well inside Supabase's per-project pooler allowance.
 *
 * `DB_CONNECTION_LIMIT` overrides it without a rebuild.
 */
const DEFAULT_CONNECTION_LIMIT = 5;
/** Prisma's own default is 10 s. A cold pooler can take longer than that to hand
 *  over a connection, and the timeout surfaces as an opaque 500 (P2024). */
const DEFAULT_POOL_TIMEOUT_S = 20;

function intFromEnv(name: string, fallback: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.round(raw), max);
}

/**
 * The connection URL with pool sizing applied.
 *
 * Written here rather than left to the environment so the value travels with the
 * code: DATABASE_URL is set by hand in the Render dashboard, and the pin it
 * carries today (`connection_limit=1`) is only correct for the per-route clients
 * this module no longer creates.
 */
export function poolUrl(raw: string | undefined = process.env.DATABASE_URL) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.set("connection_limit", String(intFromEnv("DB_CONNECTION_LIMIT", DEFAULT_CONNECTION_LIMIT, 50)));
    url.searchParams.set("pool_timeout", String(intFromEnv("DB_POOL_TIMEOUT", DEFAULT_POOL_TIMEOUT_S, 120)));
    return url.toString();
  } catch {
    // Not a URL we can parse (a socket path, say) — hand it back untouched
    // rather than losing the connection string over a query parameter.
    return raw;
  }
}

function createClient() {
  const url = poolUrl();
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(url ? { datasources: { db: { url } } } : {})
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

globalForPrisma.prisma = prisma;

/**
 * Run a read once more if the pool said no.
 *
 * Sharing one client removes the cause of most pool timeouts, but a hosted
 * pooler still drops a connection now and then (Supabase recycles them, and a
 * free Render instance waking from idle reconnects everything at once). One
 * retry after a short pause turns that into a slightly slow request instead of a
 * 500 the user has to see.
 *
 * Reads only. Nothing here is safe for a write that may have partly applied.
 */
export async function readWithRetry<T>(run: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientDbError(error) || attempt === attempts) throw error;
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError;
}
