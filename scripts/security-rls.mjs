/**
 * Apply and verify the Supabase RLS hardening in scripts/security-rls.sql.
 *
 *   node scripts/security-rls.mjs --check    audit only, changes nothing
 *   node scripts/security-rls.mjs            audit, apply, re-audit
 *
 * The --check pass is the point: it prints what anon and authenticated can
 * currently reach, so "the warning is fixed" is something you read off the
 * database rather than something the script claims.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const checkOnly = process.argv.includes("--check");
const here = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put it in .env.local.");
  process.exit(1);
}

// Same reason as scripts/apply-schema.mjs: the pooler presents a self-signed
// chain, and pg promotes `sslmode=require` to verify-full, which then refuses.
const parsed = new URL(url);
parsed.searchParams.delete("sslmode");
const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000
});

const TABLES = `
  SELECT c.relname AS table, c.relrowsecurity AS rls,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  ORDER BY 1`;

/** Every privilege anon or authenticated still holds in public. Empty is the goal. */
const GRANTS = `
  SELECT grantee, table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
  GROUP BY 1, 2 ORDER BY 1, 2`;

const SCHEMA_USAGE = `
  SELECT r.rolname AS role, has_schema_privilege(r.rolname, 'public', 'USAGE') AS usage_on_public
  FROM pg_roles r WHERE r.rolname IN ('anon','authenticated') ORDER BY 1`;

async function audit(label) {
  console.log(`\n──────── ${label} ────────`);
  const tables = await client.query(TABLES);
  console.table(tables.rows);
  const without = tables.rows.filter(r => !r.rls).map(r => r.table);
  console.log(without.length ? `RLS DISABLED on: ${without.join(", ")}` : "RLS enabled on every table in public.");

  const usage = await client.query(SCHEMA_USAGE);
  console.table(usage.rows);

  const grants = await client.query(GRANTS);
  if (grants.rows.length) {
    console.log(`anon/authenticated still hold grants on ${grants.rows.length} table(s):`);
    console.table(grants.rows);
  } else {
    console.log("anon and authenticated hold no privileges on any table in public.");
  }
  return { exposed: without.length, grants: grants.rows.length };
}

/** The whole point of the fix is that Prisma's own access is untouched. */
async function proveOwnerStillReads() {
  const rows = await client.query(`
    SELECT (SELECT count(*) FROM public."User")::int   AS users,
           (SELECT count(*) FROM public."File")::int   AS files,
           (SELECT count(*) FROM public."Folder")::int AS folders`);
  console.log("\nOwner-role read after hardening (this is the connection the app uses):");
  console.table(rows.rows);
}

try {
  await client.connect();
  const before = await audit("BEFORE");

  if (checkOnly) {
    console.log("\n--check: nothing was changed.");
  } else if (before.exposed === 0 && before.grants === 0) {
    console.log("\nAlready hardened; nothing to do.");
  } else {
    await client.query(readFileSync(path.join(here, "security-rls.sql"), "utf8"));
    const after = await audit("AFTER");
    await proveOwnerStillReads();
    if (after.exposed || after.grants) {
      console.error("\nFAILED: something in public is still reachable. See the table above.");
      process.exitCode = 1;
    } else {
      console.log("\nDone. Re-run Supabase's security advisor to confirm the warning has cleared.");
    }
  }
} catch (err) {
  console.error("\nFailed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
