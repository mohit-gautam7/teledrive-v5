import assert from "node:assert/strict";
import { uploadDirectParts, DIRECT_PART_SIZE, DIRECT_MAX_BYTES } from "../lib/direct-parts.ts";

const data = new Uint8Array(DIRECT_PART_SIZE * 2 + 17).fill(90);
const file = new Blob([data]);
file.arrayBuffer = () => assert.fail("Do not load the whole file into memory");
const sent = [];
let active = 0, peak = 0;
const progress = [];
assert.equal(await uploadDirectParts(file, async (index, bytes, count) => {
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, index === 0 ? 5 : 1));
  assert.equal(count, 3);
  assert.ok(bytes.length <= DIRECT_PART_SIZE);
  assert.ok(bytes.every(byte => byte === 90));
  sent[index] = bytes.length;
  active--;
  return true;
}, bytes => progress.push(bytes)), 3);
assert.deepEqual(sent, [DIRECT_PART_SIZE, DIRECT_PART_SIZE, 17]);
assert.ok(peak <= 2);
assert.ok(progress.every((n,i) => n < file.size && (i===0 || n >= progress[i-1])));
const stop = new AbortController(); stop.abort();
await assert.rejects(uploadDirectParts(file, () => assert.fail("No bytes after cancellation"), () => {}, stop.signal), {name:"AbortError"});
let failureCalls = 0;
await assert.rejects(uploadDirectParts(file, async () => {failureCalls++; return false;}, () => {}), /did not accept/);
assert.ok(failureCalls <= 2, "stop scheduling new parts after rejection");
await assert.rejects(uploadDirectParts({size:DIRECT_MAX_BYTES+1}, () => assert.fail(), () => {}), /exceeds/);
console.log("direct parts: bounded slices, final short part, concurrency, cancellation, rejection and size limit passed");
