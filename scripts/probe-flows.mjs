/**
 * Do the existing flows still work? Upload, download, folders, moving, copying,
 * trash, restore, shares, linking, AI.
 *
 * Everything it touches it creates, and everything it creates it deletes —
 * including the Telegram-side copies, via the app's own permanent-delete path.
 */
import "dotenv/config";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://localhost:3000";
const TELEGRAM_ID = process.env.PROBE_TELEGRAM_ID;
if (!TELEGRAM_ID) throw new Error("set PROBE_TELEGRAM_ID");

const failures = [];
function record(name, ok, detail) {
  console.log(ok ? "PASS" : "FAIL", "-", name, detail !== undefined ? `(${detail})` : "");
  if (!ok) failures.push(name);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const user = (
  await db.query('select id, "telegramId", name, username, avatar from "User" where "telegramId" = $1', [TELEGRAM_ID])
).rows[0];
const cookie = `teledrive_session=${jwt.sign(
  { id: user.id, telegramId: user.telegramId, name: user.name, username: user.username, avatar: user.avatar },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
)}`;

async function api(path, init = {}) {
  return fetch(BASE + path, { ...init, headers: { ...(init.headers || {}), cookie, origin: BASE }, redirect: "manual" });
}
async function json(path, init) {
  const res = await api(path, init);
  return { res, body: await res.json().catch(() => ({})) };
}
const post = (path, data) =>
  json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const patch = (path, data) =>
  json(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

const made = { folders: [], files: [], shares: [] };

try {
  // ── The page load ──────────────────────────────────────────────────────────
  {
    const { res, body } = await json("/api/overview");
    record("overview answers in one request", res.status === 200 && Boolean(body.user), `HTTP ${res.status}`);
    record("  ...carries folders, stats and the link state", "folders" in body && "stats" in body && "link" in body);
  }
  {
    const { res, body } = await json("/api/files?take=24");
    record("file listing honours ?take", res.status === 200 && Array.isArray(body.files), `${body.files?.length} files`);
  }
  {
    const { res, body } = await json("/api/telegram/link");
    record("account linking reports its state", res.status === 200 && "linked" in body, `linked=${body.linked}`);
  }
  {
    const { res } = await json("/api/ai/overview");
    record("AI section answers", res.status === 200 || res.status === 404, `HTTP ${res.status}`);
  }
  {
    const { res, body } = await json("/api/files/stats?full=1");
    record("insights answer", res.status === 200 && typeof body.totalSize === "number", `HTTP ${res.status}`);
  }

  // ── Folders ────────────────────────────────────────────────────────────────
  const parent = (await post("/api/folders", { name: `probe-parent-${Date.now()}` })).body.folder;
  made.folders.push(parent.id);
  record("folder created", Boolean(parent?.id));

  const child = (await post("/api/folders", { name: "probe-child", parentId: parent.id })).body.folder;
  made.folders.push(child.id);
  record("nested folder created", child?.parentId === parent.id);

  const renamed = await patch(`/api/folders/${child.id}`, { name: "probe-child-renamed" });
  record("folder renamed", renamed.body.folder?.name === "probe-child-renamed");

  // ── Upload (bot path) ──────────────────────────────────────────────────────
  const bytes = crypto.randomBytes(64 * 1024);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), "probe-small.bin");
    form.append("folderId", child.id);
    const res = await api("/api/upload", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    record("small file uploads through the bot", res.status === 200 && Boolean(body.file?.id), `HTTP ${res.status} ${body.error || ""}`);
    if (body.file?.id) {
      made.files.push(body.file.id);
      record("  ...landed in the folder it was sent to", body.file.folderId === child.id);
    }
  }
  const fileId = made.files[0];
  if (fileId) {
    const dl = await api(`/api/download/${fileId}`);
    const back = Buffer.from(await dl.arrayBuffer());
    record("download round-trips byte-identical", crypto.createHash("sha256").update(back).digest("hex") === digest, `${back.length} bytes`);

    // ── Move ─────────────────────────────────────────────────────────────────
    const moved = await patch(`/api/files/${fileId}`, { folderId: parent.id });
    record("file moved between folders", moved.res.status === 200 && moved.body.file?.folderId === parent.id);

    const bulk = await post("/api/files/bulk", { ids: [fileId], action: "move", folderId: child.id });
    record("bulk move works", bulk.res.status === 200);

    // ── Favourite ────────────────────────────────────────────────────────────
    const fav = await patch(`/api/files/${fileId}`, { isFavorite: true });
    record("favourite toggles", fav.body.file?.isFavorite === true);
    const favView = await json("/api/files?view=favorites&take=100");
    record("  ...and shows in Favourites", (favView.body.files ?? []).some(f => f.id === fileId));
    await patch(`/api/files/${fileId}`, { isFavorite: false });

    // ── Rename ───────────────────────────────────────────────────────────────
    const rn = await patch(`/api/files/${fileId}`, { name: "probe-renamed.bin" });
    record("file renamed", rn.body.file?.originalName === "probe-renamed.bin");

    // ── Share ────────────────────────────────────────────────────────────────
    const share = await post("/api/share", { fileId });
    const shareToken = String(share.body.shareUrl || "").split("/").pop();
    if (share.body.share?.id) made.shares.push(share.body.share.id);
    record("share link created", Boolean(shareToken));
    const open = await fetch(`${BASE}/api/share/${shareToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    record("share opens without a password", open.status === 200, `HTTP ${open.status}`);
    const pub = await fetch(`${BASE}/api/public/download/${shareToken}`);
    const pubBytes = Buffer.from(await pub.arrayBuffer());
    record("shared file downloads publicly", pub.status === 200 && pubBytes.length === bytes.length, `HTTP ${pub.status}`);

    // ── Zip ──────────────────────────────────────────────────────────────────
    const zip = await api("/api/download/zip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderIds: [parent.id] })
    });
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    record(
      "folder downloads as a zip",
      zip.status === 200 && zipBytes.subarray(0, 2).toString() === "PK",
      `HTTP ${zip.status}, ${zipBytes.length} bytes`
    );

    // ── Trash and restore ────────────────────────────────────────────────────
    const trashed = await api(`/api/files/${fileId}`, { method: "DELETE" });
    record("file trashed, not destroyed", trashed.status === 200 && (await trashed.json()).permanent === false);
    const inTrash = await json("/api/files?view=trash&take=100");
    record("  ...appears in Trash", (inTrash.body.files ?? []).some(f => f.id === fileId));
    const restored = await patch(`/api/files/${fileId}`, { restore: true });
    record("file restored from Trash", restored.res.status === 200 && restored.body.file?.isDeleted === false);
  }

  // ── Copy a folder ──────────────────────────────────────────────────────────
  {
    const copied = await post(`/api/folders/${parent.id}/copy`, { name: "probe-copy" });
    record("folder copied by reference", copied.res.status === 200 && copied.body.fileCount >= 1, `${copied.body.fileCount} files`);
    if (copied.body.folder?.id) made.folders.push(copied.body.folder.id);
    for (const f of copied.body.folders ?? []) if (f.id !== copied.body.folder?.id) made.folders.push(f.id);
    // The copy shares Telegram bytes with the original; deleting one must not
    // break the other. That is what purgeTelegramCopies' twin check is for.
    const copies = (
      await db.query('select id from "File" where "userId"=$1 and "originalName" like $2', [user.id, "probe-%"])
    ).rows.map(r => r.id);
    for (const id of copies) if (!made.files.includes(id)) made.files.push(id);
  }
} finally {
  // ── Clean up: files permanently (revoking Telegram), then folders ──────────
  for (const id of made.shares) await api(`/api/share/manage/${id}`, { method: "DELETE" });
  for (const id of made.files) {
    await api(`/api/files/${id}`, { method: "DELETE" });
    await api(`/api/files/${id}`, { method: "DELETE" });
  }
  for (const id of [...made.folders].reverse()) await api(`/api/folders/${id}`, { method: "DELETE" });
  // A deleted folder trashes its files rather than destroying them, so sweep any
  // probe row that survived that path.
  const leftovers = (
    await db.query('select id from "File" where "userId"=$1 and "originalName" like $2', [user.id, "probe-%"])
  ).rows.map(r => r.id);
  for (const id of leftovers) {
    await api(`/api/files/${id}`, { method: "DELETE" });
    await api(`/api/files/${id}`, { method: "DELETE" });
  }
  const files = (
    await db.query('select count(*)::int n from "File" where "userId"=$1 and "originalName" like $2', [user.id, "probe-%"])
  ).rows[0].n;
  const folders = (
    await db.query(`select count(*)::int n from "Folder" where "userId"=$1 and name like 'probe-%'`, [user.id])
  ).rows[0].n;
  console.log(`cleanup: ${files} probe files and ${folders} probe folders left`);
  if (files || folders) failures.push("cleanup");
  await db.end();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nall existing flows still work");
if (failures.length) process.exitCode = 1;
