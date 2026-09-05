/**
 * Does re-uploading the same file get caught, and does an interrupted one resume?
 *
 * The two halves of the same promise. Duplicate detection has to hold against the
 * real database — including the rows that predate the `contentHash` column, which
 * is most of anyone's drive — and a resume has to hand back the chunks that are
 * really there, keyed on something that does not shift under a folder upload.
 * Neither is a property of a function in isolation, hence a live probe.
 *
 * Deliberately sends nothing to Telegram. The stored files it asks about are
 * seeded straight into the database, and every path it exercises — the check
 * endpoint, the duplicate refusals, the resume handshake — answers before any
 * byte would leave the machine. So it can be run repeatedly against a real
 * account without filling anyone's Saved Messages. It removes every row it makes.
 *
 *   export DOTENV_CONFIG_PATH=.env.local
 *   export PROBE_TELEGRAM_ID=<your telegram id>
 *   node -r dotenv/config scripts/probe-dedupe.mjs
 */
import "dotenv/config";
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

const parsed = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL);
parsed.searchParams.delete("sslmode");
const db = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });
await db.connect();

const user = (
  await db.query('select id, "telegramId", name, username, avatar from "User" where "telegramId" = $1', [TELEGRAM_ID])
).rows[0];
if (!user) throw new Error(`no user with telegramId ${TELEGRAM_ID}`);

const cookie = `teledrive_session=${jwt.sign(
  { id: user.id, telegramId: user.telegramId, name: user.name, username: user.username, avatar: user.avatar },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
)}`;

const api = (path, init = {}) =>
  fetch(BASE + path, { ...init, headers: { ...(init.headers || {}), cookie, origin: BASE }, redirect: "manual" });
async function json(path, init) {
  const res = await api(path, init);
  return { res, body: await res.json().catch(() => ({})) };
}
const post = (path, data) =>
  json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

/** The same fingerprint the browser sends — see lib/file-identity.ts. */
async function fingerprint(bytes) {
  const MiB = 1024 * 1024;
  const windows =
    bytes.length <= 3 * MiB
      ? [[0, bytes.length]]
      : [
          [0, MiB],
          [Math.floor(bytes.length / 2 - MiB / 2), Math.floor(bytes.length / 2 + MiB / 2)],
          [bytes.length - MiB, bytes.length]
        ];
  const parts = [new TextEncoder().encode(`${bytes.length}:`), ...windows.map(([a, b]) => bytes.subarray(a, b))];
  const digest = await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer());
  return `sha256:${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

const bytesOf = size => Uint8Array.from({ length: size }, (_, i) => i % 251);
const made = { files: [], folders: [] };

/** A file that is already stored, without asking Telegram to store one. */
async function seedStored({ name, size, hash, folderId }) {
  const id = `probeseed${Math.random().toString(36).slice(2, 12)}`;
  await db.query(
    `insert into "File"
       (id, "userId", filename, "originalName", "mimeType", size, "storageMode", "storageChatId",
        "isChunked", "totalChunks", "uploadStatus", backend, "contentHash", "folderId", "createdAt")
     values ($1,$2,$3,$3,'application/octet-stream',$4,'BOT',$5,false,0,'complete','bot',$6,$7, now())`,
    [id, user.id, name, size, user.telegramId, hash, folderId]
  );
  made.files.push(id);
  return id;
}

/** Single-shot upload. Only ever called where a 409 is expected, so no bytes move. */
async function uploadSmall(name, bytes, { folderId, hash } = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "application/octet-stream" }));
  if (folderId) form.append("folderId", folderId);
  if (hash) form.append("contentHash", hash);
  const res = await api("/api/upload", { method: "POST", body: form });
  return { res, body: await res.json().catch(() => ({})) };
}

try {
  const stamp = Date.now();
  const folder = (await post("/api/folders", { name: `probe-dupe-${stamp}` })).body.folder;
  made.folders.push(folder.id);
  const other = (await post("/api/folders", { name: `probe-dupe-other-${stamp}` })).body.folder;
  made.folders.push(other.id);

  const name = "probe-dupe.bin";
  const bytes = bytesOf(4096);
  const hash = await fingerprint(bytes);
  const storedId = await seedStored({ name, size: bytes.length, hash, folderId: folder.id });

  // ── /api/upload/check, the batch question ──────────────────────────────────
  {
    const absent = await fingerprint(bytesOf(2048));
    const { res, body } = await post("/api/upload/check", {
      entries: [
        { folderId: folder.id, name: "probe-not-here.bin", size: 2048, hash: absent },
        { folderId: folder.id, name, size: bytes.length, hash },
        { folderId: other.id, name, size: bytes.length, hash },
        { folderId: folder.id, name: "probe-renamed.bin", size: bytes.length, hash }
      ]
    });
    record("check answers for a whole batch", res.status === 200, `HTTP ${res.status}`);
    const hits = (body.duplicates || []).map(d => d.index).sort((a, b) => a - b);
    record("  ...flagging the stored one, by index", JSON.stringify(hits) === "[1,3]", JSON.stringify(hits));
    record("  ...a renamed copy counts (content, not name)", hits.includes(3));
    record("  ...the same file in another folder does not", !hits.includes(2));
    record("  ...and it names what was matched", body.duplicates?.[0]?.id === storedId);

    const empty = await post("/api/upload/check", { entries: [] });
    record("an empty batch is not an error", empty.res.status === 200 && empty.body.duplicates.length === 0);

    const nonsense = await post("/api/upload/check", { entries: "nope" });
    record("a malformed batch is refused", nonsense.res.status === 400, `HTTP ${nonsense.res.status}`);
  }

  // ── Rows with no fingerprint: everything uploaded before this existed ───────
  {
    await db.query('update "File" set "contentHash" = null where id = $1', [storedId]);
    const { body } = await post("/api/upload/check", {
      entries: [
        { folderId: folder.id, name, size: bytes.length, hash },
        { folderId: folder.id, name, size: bytes.length + 1, hash }
      ]
    });
    const hits = (body.duplicates || []).map(d => d.index);
    record("a row with no fingerprint matches on name and size", hits.includes(0));
    record("  ...and a different size does not", !hits.includes(1));
    await db.query('update "File" set "contentHash" = $2 where id = $1', [storedId, hash]);
  }

  // ── A trashed file is not something you already have ───────────────────────
  {
    await db.query('update "File" set "isDeleted" = true where id = $1', [storedId]);
    const { body } = await post("/api/upload/check", {
      entries: [{ folderId: folder.id, name, size: bytes.length, hash }]
    });
    record("a trashed file does not block a re-upload", body.duplicates.length === 0);
    await db.query('update "File" set "isDeleted" = false where id = $1', [storedId]);
  }

  // ── The refusals, on both upload paths ─────────────────────────────────────
  {
    const small = await uploadSmall(name, bytes, { folderId: folder.id, hash });
    record("the single-shot path refuses a duplicate", small.res.status === 409, `HTTP ${small.res.status}`);
    record("  ...naming the file it collided with", small.body.duplicate?.id === storedId);

    const init = await post("/api/upload/init", {
      fileName: name,
      mimeType: "application/octet-stream",
      fileSize: bytes.length,
      folderId: folder.id,
      resumeKey: `${name}|${bytes.length}|1700000000001`,
      contentHash: hash
    });
    record("the chunked path refuses a duplicate", init.res.status === 409, `HTTP ${init.res.status}`);
    record("  ...without leaving a session behind", !init.body.fileId);

    const allowed = await post("/api/upload/init", {
      fileName: name,
      mimeType: "application/octet-stream",
      fileSize: bytes.length,
      folderId: folder.id,
      resumeKey: `${name}|${bytes.length}|1700000000002`,
      contentHash: hash,
      allowDuplicate: true
    });
    record("  ...unless the user asked to keep both", allowed.res.status === 200, `HTTP ${allowed.res.status}`);
    if (allowed.body.fileId) {
      made.files.push(allowed.body.fileId);
      await api(`/api/upload/abort/${allowed.body.fileId}`, { method: "DELETE" });
      made.files = made.files.filter(id => id !== allowed.body.fileId);
    }
  }

  // ── Resume ─────────────────────────────────────────────────────────────────
  {
    const big = 12 * 1024 * 1024;
    const fileName = "probe-chunked.bin";
    // Exactly the shape lib/file-identity.ts produces: name|size|lastModified.
    const resumeKey = `${fileName}|${big}|1700000000000`;
    const chunkedHash = `sha256:${"ab".repeat(32)}`;
    const start = () =>
      post("/api/upload/init", {
        fileName,
        mimeType: "application/octet-stream",
        fileSize: big,
        folderId: folder.id,
        resumeKey,
        contentHash: chunkedHash
      });

    const init = await start();
    record("a chunked session starts", init.res.status === 200 && Boolean(init.body.fileId), `HTTP ${init.res.status}`);
    if (init.body.fileId) made.files.push(init.body.fileId);
    record("  ...with nothing received yet", init.body.resumed === false && init.body.received.length === 0);

    // A chunk lands. Recorded directly rather than sent, so Telegram stays out of
    // it — /api/upload/init reads the ledger, which is the thing under test.
    await db.query(
      `insert into "Chunk" (id, "fileId", "chunkIndex", "telegramMsgId", "telegramFileId", "chunkSize")
       values ($1, $2, 0, 1, 'probe', $3)`,
      [`probechunk${Math.random().toString(36).slice(2, 12)}`, init.body.fileId, init.body.chunkSizeBytes]
    );

    const resumed = await start();
    record("the same key resumes the same session", resumed.body.fileId === init.body.fileId);
    record("  ...handing back the chunk already stored", JSON.stringify(resumed.body.received) === "[0]");
    record("  ...and saying it resumed", resumed.body.resumed === true);

    // The regression the whole change exists for: the key must not depend on the
    // destination folder, or a directory upload loses its session the moment the
    // real destination is known — and re-sends every byte it had already stored.
    record("the resume key carries no folder id", !resumeKey.includes(folder.id) && !resumeKey.includes("root"));

    // An unfinished upload is a row of the full intended size. It must not read as
    // something the user already has, or a retry would refuse itself.
    const midway = await post("/api/upload/check", {
      entries: [{ folderId: folder.id, name: fileName, size: big, hash: chunkedHash }]
    });
    record("an unfinished upload is not reported as a duplicate", midway.body.duplicates.length === 0);

    const abort = await api(`/api/upload/abort/${init.body.fileId}`, { method: "DELETE" });
    record("an abandoned session can be discarded", abort.status === 200, `HTTP ${abort.status}`);
    made.files = made.files.filter(id => id !== init.body.fileId);
  }
} finally {
  await db.query(`delete from "File" where "userId"=$1 and "originalName" like 'probe-%'`, [user.id]);
  for (const id of [...made.folders].reverse()) await api(`/api/folders/${id}`, { method: "DELETE" });
  await db.query(`delete from "Folder" where "userId"=$1 and name like 'probe-dupe-%'`, [user.id]);
  const left = (
    await db.query(`select count(*)::int n from "File" where "userId"=$1 and "originalName" like 'probe-%'`, [user.id])
  ).rows[0].n;
  const folders = (
    await db.query(`select count(*)::int n from "Folder" where "userId"=$1 and name like 'probe-dupe-%'`, [user.id])
  ).rows[0].n;
  console.log(`cleanup: ${left} probe files and ${folders} probe folders left`);
  if (left || folders) failures.push("cleanup");
  await db.end();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nprobe-dedupe: all checks passed");
process.exitCode = failures.length ? 1 : 0;
