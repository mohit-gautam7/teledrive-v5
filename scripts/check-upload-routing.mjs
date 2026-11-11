import assert from "node:assert/strict";
import { isHeavyPath } from "../lib/file-origin.ts";

for (const path of ["/api/upload/init", "/api/upload/direct/test-file", "/api/upload/check"]) {
  assert.equal(isHeavyPath(path), false, `${path} must remain on the metadata host`);
}
for (const path of ["/api/upload", "/api/upload/chunk/test-file/0", "/api/upload/complete/test-file", "/api/download/test-file", "/api/stream/test-file"]) {
  assert.equal(isHeavyPath(path), true, `${path} must remain on the file host`);
}
console.log("upload-routing: metadata bypasses the relay; file bytes still use it");
