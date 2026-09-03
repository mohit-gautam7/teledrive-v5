/**
 * Live security probe against a running production build.
 *
 *   OWNER_LOGIN_KEY=… node scripts/probe-security.mjs
 *
 * Read-mostly: the only writes are one share it creates and deletes again.
 */
import assert from "node:assert/strict";

const BASE = process.env.PROBE_BASE || "http://localhost:3000";
const KEY = process.env.OWNER_LOGIN_KEY;
let cookie = "";
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", "-", name, detail ? `(${detail})` : "");
}

async function req(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    redirect: "manual",
    headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}), origin: BASE }
  });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const pair = c.split(";")[0];
    if (!pair.split("=")[1]) continue;
    const name = pair.split("=")[0];
    cookie = cookie
      .split("; ")
      .filter(Boolean)
      .filter(x => !x.startsWith(name + "="))
      .concat(pair)
      .join("; ");
  }
  return res;
}

async function json(path, init) {
  const res = await req(path, init);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

// ── 1. Anonymous access is refused everywhere ────────────────────────────────
for (const path of ["/api/files", "/api/overview", "/api/share", "/api/files/stats", "/api/settings/storage"]) {
  const res = await req(path);
  record(`anonymous ${path} is refused`, res.status === 401, `HTTP ${res.status}`);
}

// ── 2. Sign in ───────────────────────────────────────────────────────────────
assert.ok(KEY, "set OWNER_LOGIN_KEY to the value the server was started with");
{
  const { res } = await json("/api/auth/owner-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "wrong-key-entirely" })
  });
  record("owner-login rejects a wrong key", res.status === 401, `HTTP ${res.status}`);
}
{
  const { res } = await json("/api/auth/owner-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: KEY })
  });
  assert.equal(res.status, 200, "owner-login failed — is OWNER_LOGIN_KEY set on the server?");
  record("owner-login accepts the right key", true);
}

// ── 3. Someone else's rows are 404, not 403 or 200 ───────────────────────────
const FOREIGN = "cxxxxxxxxxxxxxxxxxxxxxxxx";
for (const [name, path, init] of [
  ["file", `/api/files/${FOREIGN}`, { method: "DELETE" }],
  ["download", `/api/download/${FOREIGN}`, {}],
  ["stream", `/api/stream/${FOREIGN}`, {}],
  ["preview", `/api/preview/${FOREIGN}`, {}],
  ["folder", `/api/folders/${FOREIGN}`, { method: "DELETE" }],
  ["share", `/api/share/manage/${FOREIGN}`, { method: "DELETE" }],
  ["ai key", `/api/ai/keys/${FOREIGN}`, { method: "DELETE" }]
]) {
  const res = await req(path, init);
  record(`unknown ${name} id is 404`, res.status === 404, `HTTP ${res.status}`);
}

// ── 4. A folder id in a request body must be one of ours ─────────────────────
const { body: listing } = await json("/api/files?take=100");
const files = listing.files ?? [];
record("listing returned files to work with", files.length > 0, `${files.length} files`);
const victim = files[0];

if (victim) {
  const before = victim.folderId ?? null;
  const { res } = await json(`/api/files/${victim.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderId: FOREIGN })
  });
  record("move into an unowned folder is refused", res.status === 404, `HTTP ${res.status}`);

  const { body: after } = await json(`/api/files?take=100`);
  const now = (after.files ?? []).find(f => f.id === victim.id);
  record("...and the file did not move", (now?.folderId ?? null) === before);

  const bulk = await json("/api/files/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [victim.id], action: "move", folderId: FOREIGN })
  });
  record("bulk move into an unowned folder is refused", bulk.res.status === 404, `HTTP ${bulk.res.status}`);

  const nested = await json("/api/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "probe-should-not-exist", parentId: FOREIGN })
  });
  record("folder under an unowned parent is refused", nested.res.status === 404, `HTTP ${nested.res.status}`);
}

// ── 5. Only renderable types are served inline ───────────────────────────────
const risky = files.find(f => /\.(html?|svg|xht|xml)$/i.test(f.originalName) || /html|svg|xml/i.test(f.mimeType));
const picture = files.find(f => /^image\/(png|jpeg|webp|gif)$/i.test(f.mimeType));

if (picture) {
  const res = await req(`/api/preview/${picture.id}`, { headers: { range: "bytes=0-64" } });
  const disp = res.headers.get("content-disposition") || "";
  record("a real image still renders inline", disp.startsWith("inline"), disp.slice(0, 40));
  record("...and carries nosniff", res.headers.get("x-content-type-options") === "nosniff");
  record("...and a locked-down CSP", (res.headers.get("content-security-policy") || "").includes("sandbox"));
  await res.body?.cancel();
}
if (risky) {
  const res = await req(`/api/stream/${risky.id}`, { headers: { range: "bytes=0-64" } });
  const disp = res.headers.get("content-disposition") || "";
  const type = res.headers.get("content-type") || "";
  record(
    `scriptable type "${risky.mimeType}" is not rendered inline`,
    disp.startsWith("attachment") && !/html|svg|xml/i.test(type),
    `${type} / ${disp.slice(0, 30)}`
  );
  await res.body?.cancel();
} else {
  console.log("SKIP - no scriptable file in this account to test against");
}

// ── 6. Share links: password, expiry, disabled, revoked ──────────────────────
let shareId = null;
if (victim) {
  const created = await json("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileId: victim.id, password: "correct horse" })
  });
  const token = String(created.body.shareUrl || "").split("/").pop();
  shareId = created.body.share?.id ?? null;
  record("password share created", Boolean(token), token);

  if (token) {
    // No cookie yet: the bytes must not be served.
    const cold = await fetch(`${BASE}/api/public/download/${token}`, { redirect: "manual" });
    record("locked share refuses the bytes", cold.status === 401, `HTTP ${cold.status}`);
    await cold.body?.cancel();

    const wrong = await fetch(`${BASE}/api/share/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" })
    });
    record("wrong password is refused", wrong.status === 401, `HTTP ${wrong.status}`);

    const right = await fetch(`${BASE}/api/share/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse" })
    });
    const unlock = (right.headers.getSetCookie?.() ?? []).find(c => c.startsWith(`td_share_${token}=`));
    record("right password opens the share", right.status === 200, `HTTP ${right.status}`);
    record("...and issues an unlock cookie", Boolean(unlock));

    if (unlock) {
      const warm = await fetch(`${BASE}/api/public/download/${token}`, {
        headers: { cookie: unlock.split(";")[0] },
        redirect: "manual"
      });
      record("unlocked share serves the bytes", warm.status === 200 || warm.status === 206, `HTTP ${warm.status}`);
      await warm.body?.cancel();

      // The cookie names its own share, so it cannot be replayed at another.
      const otherToken = "a".repeat(24);
      const replay = await fetch(`${BASE}/api/public/download/${otherToken}`, {
        headers: { cookie: unlock.split(";")[0].replace(token, otherToken) },
        redirect: "manual"
      });
      record("an unlock cookie does not open another share", replay.status !== 200, `HTTP ${replay.status}`);
      await replay.body?.cancel();
    }

    // Disabled server-side, not just hidden in the UI.
    if (shareId) {
      await json(`/api/share/manage/${shareId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true, password: null })
      });
      const off = await fetch(`${BASE}/api/public/download/${token}`, { redirect: "manual" });
      record("disabled share is refused", off.status === 404, `HTTP ${off.status}`);
      await off.body?.cancel();

      // Expiry in the past, enabled again.
      await json(`/api/share/manage/${shareId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false, expiryDate: new Date(Date.now() - 60_000).toISOString() })
      });
      const expired = await fetch(`${BASE}/api/public/download/${token}`, { redirect: "manual" });
      record("expired share is refused", expired.status === 410, `HTTP ${expired.status}`);
      await expired.body?.cancel();

      // Revocation.
      const gone = await json(`/api/share/manage/${shareId}`, { method: "DELETE" });
      record("share revoked", gone.res.status === 200, `HTTP ${gone.res.status}`);
      const dead = await fetch(`${BASE}/api/public/download/${token}`, { redirect: "manual" });
      record("revoked share is refused", dead.status === 404, `HTTP ${dead.status}`);
      await dead.body?.cancel();
      shareId = null;
    }
  }
}

// ── 7. Rate limits ───────────────────────────────────────────────────────────
{
  const token = "b".repeat(24);
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await fetch(`${BASE}/api/share/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "guess" + i })
    });
    if (res.status === 429) limited = true;
  }
  record("share password guessing is rate limited", limited);
}

// ── 8. A 5xx body carries a reference and nothing else ───────────────────────
{
  const res = await req("/api/files/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [], action: "move" })
  });
  const body = await res.json().catch(() => ({}));
  const leaks = JSON.stringify(body).match(/prisma|postgres|\/home\/|C:\\|at Object|node_modules/i);
  record("an error body leaks no internals", !leaks, JSON.stringify(body).slice(0, 90));
}

// ── 9. SSRF: a key may not point the server at the private network ───────────
for (const url of ["http://169.254.169.254/latest", "http://127.0.0.1:11434/v1", "http://10.0.0.5/v1"]) {
  const { res, body } = await json("/api/ai/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "local", nickname: "probe", apiKey: "x", baseUrl: url })
  });
  const refused = res.status !== 200 && res.status !== 201;
  record(`AI key pointing at ${url} is refused`, refused, `HTTP ${res.status} ${String(body.error || "").slice(0, 60)}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log("  FAILED:", f.name, f.detail ? `(${f.detail})` : "");
  process.exitCode = 1;
}
