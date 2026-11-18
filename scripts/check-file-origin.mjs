import assert from "node:assert/strict";
import { isHeavyPath } from "../lib/file-origin.ts";

// Bytes that matter go to the file origin (Render)…
for (const p of ["/api/download/abc", "/api/stream/abc", "/api/preview/abc", "/api/upload/init", "/api/public/download/tok"]) {
  assert.ok(isHeavyPath(p), `${p} should go to the file origin`);
}
// …while thumbnails and light JSON stay on the app origin (Vercel).
for (const p of ["/api/preview/abc?thumb=1", "/api/preview/abc?v=2&thumb=1", "/api/upload/check", "/api/upload/direct/abc", "/api/files"]) {
  assert.ok(!isHeavyPath(p), `${p} should stay on the app origin`);
}
assert.ok(isHeavyPath("/api/preview/abc?thumb=10"), "only thumb=1 is a thumbnail");

console.log("file origin: heavy routes split correctly");
