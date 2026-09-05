/**
 * Does the same file stay the same file, and does "skip" really skip? (P1)
 *
 * Run: node scripts/check-dedupe.mjs
 *
 * Node strips the types; lib/file-identity.ts and lib/duplicate-plan.ts import
 * nothing, so they load as-is. That is the reason both live in modules of their
 * own — the rules they hold are the ones that silently ruin an upload when they
 * drift, and they should be checkable without starting a browser.
 */
import assert from "node:assert/strict";
import { fingerprint, resumeKeyFor } from "../lib/file-identity.ts";
import { dedupeBatch, planBatch } from "../lib/duplicate-plan.ts";

const MiB = 1024 * 1024;
const file = (name, bytes, lastModified = 1_700_000_000_000) => new File([bytes], name, { lastModified });
const filled = (size, seed = 0) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i + seed) % 251;
  return bytes;
};

// ── Resume key ───────────────────────────────────────────────────────────────
// The bug: the key used to embed the destination folder id. A directory upload
// only learns its real destination after the folder chain is created, so the key
// changed underneath the resume, /api/upload/init found no session, and every
// chunk already stored was abandoned and re-sent from zero.
{
  const source = file("holiday.mp4", filled(64), 1_700_000_000_000);
  const key = resumeKeyFor(source);

  assert.equal(key, resumeKeyFor(source), "the same file must always produce the same key");
  assert.equal(resumeKeyFor.length, 1, "the key must depend on the file alone — no folder argument");
  assert.ok(!key.includes("root"), "no folder placeholder may leak into the key");

  // The three things that genuinely make it a different upload.
  assert.notEqual(key, resumeKeyFor(file("other.mp4", filled(64))), "a different name is a different upload");
  assert.notEqual(key, resumeKeyFor(file("holiday.mp4", filled(65))), "a different size is a different upload");
  assert.notEqual(
    key,
    resumeKeyFor(file("holiday.mp4", filled(64), 1_700_000_000_001)),
    "an edited file is a different upload"
  );
}

// ── Content fingerprint ──────────────────────────────────────────────────────
{
  const small = filled(3 * MiB - 7);
  const hash = await fingerprint(file("a.bin", small));
  assert.ok(hash?.startsWith("sha256:"), "a fingerprint is a labelled sha256");
  assert.equal(hash, await fingerprint(file("renamed.bin", small)), "the name is not part of the content");
  assert.equal(hash, await fingerprint(file("a.bin", small)), "the same bytes hash the same twice");

  // Anything at or under three windows is covered end to end, so every byte counts.
  for (const at of [0, MiB + 5, 2 * MiB + 5, small.length - 1]) {
    const changed = Uint8Array.from(small);
    changed[at] ^= 0xff;
    assert.notEqual(hash, await fingerprint(file("a.bin", changed)), `a change at byte ${at} must be seen`);
  }

  // Size leads the digest, so a truncation can never collide with the original.
  assert.notEqual(hash, await fingerprint(file("a.bin", small.subarray(0, small.length - 1))));
}

// Larger than three windows: head, middle and tail are sampled, the rest is not.
{
  const big = filled(4 * MiB);
  const hash = await fingerprint(file("big.bin", big));

  for (const at of [0, 2 * MiB, 4 * MiB - 1]) {
    const changed = Uint8Array.from(big);
    changed[at] ^= 0xff;
    assert.notEqual(hash, await fingerprint(file("big.bin", changed)), `sampled byte ${at} must be seen`);
  }

  // The documented ceiling, asserted so it is a known limit rather than a
  // surprise: outside the sampled windows two different files of the same length
  // fingerprint alike. See the ponytail note in lib/file-identity.ts.
  const unsampled = Uint8Array.from(big);
  unsampled[1_200_000] ^= 0xff;
  assert.equal(hash, await fingerprint(file("big.bin", unsampled)), "sampling ceiling has moved — update the docs");
}

// ── Collapsing duplicates inside one batch ───────────────────────────────────
{
  const entry = (name, destination, contentHash, size = 10) => ({
    file: file(name, filled(size)),
    destination,
    contentHash
  });

  const collapsed = dedupeBatch([
    entry("a.bin", null, "sha256:aa"),
    entry("copy-of-a.bin", null, "sha256:aa"),
    entry("a.bin", "folder-1", "sha256:aa"),
    entry("b.bin", null, null),
    entry("b.bin", null, null)
  ]);
  assert.equal(collapsed.length, 3, "same content + same folder collapses; a different folder does not");
  assert.deepEqual(
    collapsed.map(e => e.file.name),
    ["a.bin", "a.bin", "b.bin"],
    "the first copy of each survives"
  );
}

// ── Skip / replace / keep both ───────────────────────────────────────────────
{
  const batch = ["new.bin", "dupe.bin", "also-new.bin"].map(name => ({
    file: file(name, filled(10)),
    destination: null
  }));
  const duplicates = [{ index: 1, id: "existing-1", name: "dupe.bin" }];

  const skip = planBatch(batch, duplicates, { 1: "skip" });
  assert.deepEqual(skip.queue.map(e => e.file.name), ["new.bin", "also-new.bin"], "a skipped file is not queued");
  assert.equal(skip.skipped.length, 1);
  assert.deepEqual(skip.skipped[0].duplicateOf, { id: "existing-1", name: "dupe.bin" });

  // A file that is not a duplicate must never be handed permission to become one:
  // the server check is the last line of defence against a second tab.
  assert.ok(skip.queue.every(e => !e.allowDuplicate), "non-duplicates keep the server's own check");

  const replace = planBatch(batch, duplicates, { 1: "replace" });
  assert.equal(replace.queue.length, 3);
  assert.equal(replace.skipped.length, 0);
  assert.equal(replace.queue[1].replaceFileId, "existing-1", "replace retires the file it matched");
  assert.equal(replace.queue[1].allowDuplicate, true);

  const copy = planBatch(batch, duplicates, { 1: "copy" });
  assert.equal(copy.queue.length, 3);
  assert.equal(copy.queue[1].replaceFileId, undefined, "keeping both must not delete anything");
  assert.equal(copy.queue[1].allowDuplicate, true);

  // No answer means skip — the only choice that can neither lose a file nor
  // store one twice.
  assert.deepEqual(planBatch(batch, duplicates, {}).skipped.length, 1, "an unanswered duplicate defaults to skip");

  // Everything already stored: nothing to upload, but the batch is still accounted for.
  const all = planBatch(batch, [0, 1, 2].map(index => ({ index, id: `e${index}`, name: batch[index].file.name })), {});
  assert.equal(all.queue.length, 0);
  assert.equal(all.skipped.length, 3);
}

console.log("check-dedupe: OK");
