/**
 * P1 end to end: on a linked account, does a file above the bot's own download
 * ceiling go to MTProto as ONE message in Saved Messages, and come back?
 *
 * Signs in by minting the same JWT the app's own login mints, rather than going
 * through owner-login — owner-login would upsert `name: "Owner"` onto the
 * account it signs in as, which is a real edit to someone's profile.
 *
 * The file it uploads is deleted permanently at the end, which revokes the
 * Telegram message with it. `--routing-only` stops after /init and discards the
 * session, proving the routing decision without sending a byte.
 */
import "dotenv/config";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://localhost:3000";
const TELEGRAM_ID = process.env.PROBE_TELEGRAM_ID;
const ROUTING_ONLY = process.argv.includes("--routing-only");
const MB = 1024 * 1024;
const SIZE = Number(process.env.PROBE_SIZE_MB || 22) * MB;

if (!TELEGRAM_ID) throw new Error("set PROBE_TELEGRAM_ID to a linked account's telegram id");

const failures = [];
function record(name, ok, detail) {
  console.log(ok ? "PASS" : "FAIL", "-", name, detail !== undefined ? `(${detail})` : "");
  if (!ok) failures.push(name);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const user = (
  await db.query(
    `select u.id, u."telegramId", u.name, u.username, u.avatar,
            (sc."mtprotoSession" is not null) as linked
       from "User" u left join "StorageConfig" sc on sc."userId" = u.id
      where u."telegramId" = $1`,
    [TELEGRAM_ID]
  )
).rows[0];
if (!user) throw new Error(`no user with telegramId ${TELEGRAM_ID}`);
record("account is Telegram-linked", user.linked === true);

const token = jwt.sign(
  { id: user.id, telegramId: user.telegramId, name: user.name, username: user.username, avatar: user.avatar },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
);
const cookie = `teledrive_session=${token}`;

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...(init.headers || {}), cookie, origin: BASE },
    redirect: "manual"
  });
  return res;
}

// Deterministic bytes, so the download can be checked rather than just counted.
const payload = Buffer.alloc(SIZE);
crypto.randomFillSync(payload);
const wholeDigest = crypto.createHash("sha256").update(payload).digest("hex");
const name = `teledrive-probe-${Date.now()}.bin`;

let fileId = null;
try {
  // ── init: the routing decision ─────────────────────────────────────────────
  const initRes = await api("/api/upload/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: name,
      mimeType: "application/octet-stream",
      fileSize: SIZE,
      resumeKey: `probe|${SIZE}|${Date.now()}`
    })
  });
  const init = await initRes.json();
  record("init accepted", initRes.status === 200, `HTTP ${initRes.status} ${init.error || ""}`);
  fileId = init.fileId;
  record(`${SIZE / MB} MB routes to MTProto, not bot chunks`, init.backend === "mtproto", init.backend);

  const row = (await db.query('select "storageMode","storageChatId","backend" from "File" where id=$1', [fileId])).rows[0];
  record("stored as PERSONAL", row.storageMode === "PERSONAL", row.storageMode);
  record("targets the account's Saved Messages", row.storageChatId === "me", row.storageChatId);

  // A control: the same account, one byte under the ceiling, must stay on the bot.
  const smallRes = await api("/api/upload/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: "small.bin",
      mimeType: "application/octet-stream",
      fileSize: 20 * MB,
      resumeKey: `probe-small|${Date.now()}`
    })
  });
  const small = await smallRes.json();
  record("20 MB stays on the bot", small.backend === "bot", small.backend);
  await api(`/api/upload/abort/${small.fileId}`, { method: "DELETE" });

  if (ROUTING_ONLY) {
    await api(`/api/upload/abort/${fileId}`, { method: "DELETE" });
    fileId = null;
  } else {
    // ── chunks ───────────────────────────────────────────────────────────────
    const chunkSize = init.chunkSizeBytes;
    console.log(`  uploading ${init.totalChunks} chunks of ${chunkSize / MB} MB…`);
    for (let i = 0; i < init.totalChunks; i++) {
      const slice = payload.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, SIZE));
      const form = new FormData();
      form.append("chunk", new Blob([new Uint8Array(slice)]));
      const res = await api(`/api/upload/chunk/${fileId}/${i}`, { method: "POST", body: form });
      if (res.status !== 200) {
        const b = await res.text();
        throw new Error(`chunk ${i} failed: HTTP ${res.status} ${b.slice(0, 200)}`);
      }
    }
    record("every chunk accepted", true, `${init.totalChunks} chunks`);

    // ── complete ─────────────────────────────────────────────────────────────
    const doneRes = await api(`/api/upload/complete/${fileId}`, { method: "POST" });
    const done = await doneRes.json();
    record("finalised", doneRes.status === 200, `HTTP ${doneRes.status} ${done.error || ""}`);

    const stored = (
      await db.query(
        'select "isChunked","telegramMessageId","storageChatId","uploadStatus", (select count(*)::int from "Chunk" c where c."fileId"=f.id) as chunks from "File" f where id=$1',
        [fileId]
      )
    ).rows[0];
    record("stored as ONE message, not chunks", stored.isChunked === false && stored.chunks === 0, `chunks=${stored.chunks}`);
    record("has a Telegram message id", Boolean(stored.telegramMessageId), stored.telegramMessageId);
    record("in Saved Messages", stored.storageChatId === "me", stored.storageChatId);
    record("marked complete", stored.uploadStatus === "complete", stored.uploadStatus);

    // ── download: the bytes must come back identical ─────────────────────────
    const dl = await api(`/api/download/${fileId}`);
    record("download responds", dl.status === 200, `HTTP ${dl.status}`);
    const back = Buffer.from(await dl.arrayBuffer());
    record("download is the right length", back.length === SIZE, `${back.length} vs ${SIZE}`);
    record(
      "download is byte-identical",
      crypto.createHash("sha256").update(back).digest("hex") === wholeDigest
    );

    // ── ranged read, which is what the video player does ─────────────────────
    const start = 9 * MB + 12345;
    const end = start + 65535;
    const ranged = await api(`/api/download/${fileId}`, { headers: { range: `bytes=${start}-${end}` } });
    const part = Buffer.from(await ranged.arrayBuffer());
    record("range request answers 206", ranged.status === 206, `HTTP ${ranged.status}`);
    record("range bytes match the source", part.equals(payload.subarray(start, end + 1)), `${part.length} bytes`);
  }
} finally {
  if (fileId) {
    // Trash, then permanently delete — the second one revokes the Telegram
    // message, so the probe leaves nothing behind in the account either.
    await api(`/api/files/${fileId}`, { method: "DELETE" });
    await api(`/api/files/${fileId}`, { method: "DELETE" });
    const left = (await db.query('select count(*)::int n from "File" where id=$1', [fileId])).rows[0].n;
    console.log(left === 0 ? "cleaned up: probe file deleted" : `LEFTOVER: file ${fileId} still present`);
    if (left !== 0) failures.push("cleanup");
  }
  await db.end();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nbig-file routing verified end to end");
if (failures.length) process.exitCode = 1;
