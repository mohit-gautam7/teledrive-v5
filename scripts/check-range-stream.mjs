import assert from "node:assert/strict";
import { buildRangeStream, MTPROTO_WINDOW } from "../lib/range-stream.ts";

// A fake file whose byte i is i % 251, read with random delays and a
// short read in the middle — output must still be every byte, in order.
const total = MTPROTO_WINDOW * 5 + 123;
const byte = i => i % 251;
let active = 0, peak = 0, shortDone = false;
const read = async (start, end) => {
  active++; peak = Math.max(peak, active);
  await new Promise(r => setTimeout(r, Math.random() * 5));
  active--;
  let stop = end;
  if (!shortDone && start > MTPROTO_WINDOW * 2) { shortDone = true; stop = start + 1000; }
  return Buffer.from(Array.from({ length: stop - start + 1 }, (_, k) => byte(start + k)));
};

const from = 7, to = total - 1;
const out = Buffer.from(await new Response(buildRangeStream(from, to, read)).arrayBuffer());
assert.equal(out.length, to - from + 1);
for (let k = 0; k < out.length; k++) if (out[k] !== byte(from + k)) assert.fail(`byte ${from + k} out of order`);
assert.ok(shortDone, "short read exercised");
assert.ok(peak > 1 && peak <= 4, `parallel reads: peak ${peak}`);

// An empty read must error rather than end the body early.
await assert.rejects(new Response(buildRangeStream(0, 10, async () => Buffer.alloc(0))).arrayBuffer());

console.log("range stream: ordered, parallel, short reads filled");
