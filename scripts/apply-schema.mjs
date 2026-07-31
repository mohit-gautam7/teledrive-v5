/**
 * Additive schema sync.
 *
 * `prisma db push` cannot run against this Supabase project: introspection trips
 * over the pre-existing `public.profiles → auth.users` cross-schema foreign key
 * (Prisma error P4002). This script applies the same additive DDL directly, is
 * idempotent (every statement is IF NOT EXISTS / IF EXISTS), and never drops or
 * rewrites existing data.
 *
 *   node scripts/apply-schema.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.join(here, "schema.sql"), "utf8");

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("[apply-schema] DATABASE_URL is not set.");
  process.exit(1);
}

// Supabase's pooler presents a self-signed chain. Drop sslmode from the URL and
// configure TLS explicitly, otherwise pg upgrades it to verify-full and refuses.
const parsed = new URL(url);
parsed.searchParams.delete("sslmode");
const client = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  await client.query(sql);
  console.log("[apply-schema] Schema is up to date.");
} catch (err) {
  console.error("[apply-schema] Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
