/**
 * Does a file whose stored mime type says "text/html" get *rendered*?
 *
 * That is the stored-XSS question: the mime type is whatever the uploader's
 * browser reported, so if it is echoed back on an inline response the uploader
 * chooses whether their file runs as a document on this origin.
 *
 * Nothing is uploaded. One existing file's mimeType is flipped in the database,
 * probed, and restored in a finally — so a crash mid-probe still puts it back.
 */
import "dotenv/config";
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://localhost:3000";
const KEY = process.env.OWNER_LOGIN_KEY;
const TARGET_TELEGRAM_ID = process.env.PROBE_TELEGRAM_ID || "8342038030";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const { rows } = await db.query(
  `select f.id, f."mimeType", f."originalName"
     from "File" f join "User" u on u.id = f."userId"
    where u."telegramId" = $1 and f."isDeleted" = false and f."uploadStatus" = 'complete'
    limit 1`,
  [TARGET_TELEGRAM_ID]
);
if (!rows.length) {
  console.log("SKIP - no file on that account to probe with");
  await db.end();
  process.exit(0);
}
const file = rows[0];
const original = file.mimeType;

let cookie = "";
{
  const res = await fetch(`${BASE}/api/auth/owner-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ key: KEY })
  });
  if (res.status !== 200) throw new Error(`owner-login failed: HTTP ${res.status}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
}

const failures = [];
function record(name, ok, detail) {
  console.log(ok ? "PASS" : "FAIL", "-", name, detail ? `(${detail})` : "");
  if (!ok) failures.push(name);
}

try {
  for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml"]) {
    await db.query('update "File" set "mimeType" = $1 where id = $2', [mime, file.id]);

    for (const route of ["preview", "stream"]) {
      const res = await fetch(`${BASE}/api/${route}/${file.id}`, {
        headers: { cookie, range: "bytes=0-32" }
      });
      const type = (res.headers.get("content-type") || "").toLowerCase();
      const disp = (res.headers.get("content-disposition") || "").toLowerCase();
      const csp = res.headers.get("content-security-policy") || "";
      await res.body?.cancel();

      record(
        `${mime} on /api/${route} is not rendered`,
        disp.startsWith("attachment") && !/html|svg|xml/.test(type),
        `${type} / ${disp.split(";")[0]}`
      );
      record(`  ...nosniff`, res.headers.get("x-content-type-options") === "nosniff");
      record(`  ...sandboxed CSP`, csp.includes("sandbox") && csp.includes("default-src 'none'"));
    }
  }

  // The control: a real image must still render, or the fix broke previews.
  await db.query('update "File" set "mimeType" = $1 where id = $2', ["image/jpeg", file.id]);
  const ok = await fetch(`${BASE}/api/preview/${file.id}`, { headers: { cookie, range: "bytes=0-32" } });
  const disp = (ok.headers.get("content-disposition") || "").toLowerCase();
  await ok.body?.cancel();
  record("a real image still renders inline", disp.startsWith("inline"), disp.split(";")[0]);
} finally {
  await db.query('update "File" set "mimeType" = $1 where id = $2', [original, file.id]);
  const check = await db.query('select "mimeType" from "File" where id = $1', [file.id]);
  console.log(`restored ${file.originalName} to ${check.rows[0].mimeType}`);
  await db.end();
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nall inline-rendering checks passed");
}
