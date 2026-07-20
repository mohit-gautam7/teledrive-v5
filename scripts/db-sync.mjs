/**
 * Keeps the database schema in sync automatically on every Vercel deploy —
 * no manual migrations. Changes here are additive-only (prisma db push
 * refuses anything that would lose data).
 * Skipped outside Vercel so local/sandbox builds never need DB access.
 */
import { execSync } from "node:child_process";

if (!process.env.VERCEL) {
  console.log("[db-sync] Not on Vercel — skipping db push (run `pnpm db:push` manually if needed).");
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.warn("[db-sync] DATABASE_URL not set — skipping db push. Set it in Vercel → Settings → Environment Variables.");
  process.exit(0);
}

try {
  execSync("npx prisma db push --skip-generate", { stdio: "inherit" });
  console.log("[db-sync] Database schema is up to date.");
} catch (err) {
  console.error("[db-sync] prisma db push failed — deploy aborted so code and schema never diverge.");
  process.exit(1);
}
