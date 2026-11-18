import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pull parseDirectRange and its constants out of the service worker as-is.
const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pick = re => sw.match(re)?.[0] ?? assert.fail(`missing ${re}`);
const parse = new Function(
  `${pick(/const DIRECT_WINDOW = [^;]+;/)}\n${pick(/const DIRECT_MAX = [^;]+;/)}\n${pick(/function parseDirectRange[\s\S]+?\n}\n/)}\nreturn parseDirectRange;`
)();
const MB = 1024 * 1024, size = 100 * MB;

assert.deepEqual(parse("bytes=0-", size), { start: 0, end: 2 * MB - 1 }, "open range is a bounded slice");
assert.deepEqual(parse(null, size), { start: 0, end: 2 * MB - 1 }, "no header starts at 0");
assert.deepEqual(parse("bytes=100-199", size), { start: 100, end: 199 }, "explicit range kept");
assert.deepEqual(parse("bytes=0-99999999999", size), { start: 0, end: 8 * MB - 1 }, "huge explicit range capped");
assert.deepEqual(parse(`bytes=${size - 10}-`, size), { start: size - 10, end: size - 1 }, "tail clamps to file end");
assert.deepEqual(parse("bytes=-500", size), { start: size - 500, end: size - 1 }, "suffix range");
assert.equal(parse(`bytes=${size}-`, size), null, "past the end is unsatisfiable");

console.log("direct stream: range parsing ok");
