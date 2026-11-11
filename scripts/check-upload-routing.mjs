/**
 * Does a linked account's big file go to MTProto? (P1)
 *
 * Run: node scripts/check-upload-routing.mjs
 * Node strips the types; lib/upload-config.ts imports nothing, so it loads as-is.
 */
import assert from "node:assert/strict";
import {
  BOT_DOWNLOAD_LIMIT,
  CHUNK_SIZE,
  SINGLE_SHOT_LIMIT,
  SAVED_MESSAGES,
  backendFor
} from "../lib/upload-config.ts";

const MB = 1024 * 1024;

// The bug: a linked account's 30 MB file was bot-chunked because the threshold
// sat at 64 MB. Anything a bot cannot serve back in one message must not be
// stored by the bot when there is a session to use instead.
assert.equal(backendFor(30 * MB, true), "mtproto", "30 MB on a linked account must use MTProto");
assert.equal(backendFor(BOT_DOWNLOAD_LIMIT + 1, true), "mtproto", "one byte over the bot limit must use MTProto");
assert.equal(backendFor(2048 * MB, true), "mtproto");

// At or under the limit the bot can hold it and serve it back, so it stays.
assert.equal(backendFor(BOT_DOWNLOAD_LIMIT, true), "bot");
assert.equal(backendFor(1 * MB, true), "bot");

// No session, no choice — bot chunking is the only storage there is.
assert.equal(backendFor(2048 * MB, false), "bot");
assert.equal(backendFor(30 * MB, false), "bot");

// The single-request path stores ONE bot document, so it may never accept a
// file a bot could not download again, however large UPLOAD_CHUNK_MB is set.
assert.ok(SINGLE_SHOT_LIMIT <= BOT_DOWNLOAD_LIMIT, "single-shot uploads must stay bot-downloadable");
assert.ok(SINGLE_SHOT_LIMIT <= CHUNK_SIZE);

// The Settings override. Asking for MORE of the user's own account is always
// honoured; asking for less is honoured only where the bot can still serve the
// file back, because a preference must not be able to make a file unreachable.
assert.equal(backendFor(30 * MB, true, "account"), "mtproto");
assert.equal(backendFor(1 * MB, true, "account"), "mtproto", "always-my-account applies below the bot limit too");
assert.equal(backendFor(1 * MB, true, "bot"), "bot");
assert.equal(backendFor(BOT_DOWNLOAD_LIMIT, true, "bot"), "bot");
assert.equal(backendFor(30 * MB, true, "bot"), "mtproto", "a preference must not mint an unreachable file");
assert.equal(backendFor(30 * MB, false, "account"), "bot", "no session, no choice");

assert.equal(SAVED_MESSAGES, "me");

console.log("upload routing ok — chunk", CHUNK_SIZE / MB, "MB, single-shot cap", SINGLE_SHOT_LIMIT / MB, "MB");
