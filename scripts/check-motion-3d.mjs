/**
 * Does the folder-open arc actually describe an arc? (P2)
 *
 * Run: node scripts/check-motion-3d.mjs
 *
 * The geometry is the part that fails quietly. A sign flip sends the tiles the
 * wrong way round the cylinder; a missing cap gives tile 500 the same rotation
 * as tile 1 and a folder of two thousand files becomes two thousand composited
 * layers. Neither shows up in a type check, and both look "animated" enough in
 * a screenshot to pass a glance.
 */
import assert from "node:assert/strict";
import { ORBIT_MAX, orbitEntrance } from "../lib/motion-3d.ts";

// ── The arc ──────────────────────────────────────────────────────────────────
const first = orbitEntrance(0, false);
assert.ok(first.from.rotateY > 0, "the first tile must start rotated");
assert.equal(first.to.rotateY, 0, "every tile must land flat");
assert.equal(first.to.z, 0, "every tile must land at z=0");
assert.equal(first.delay, 0, "the first tile must not wait");

// Rotation eases off along the list, so the near tiles carry the gesture.
const angles = Array.from({ length: ORBIT_MAX }, (_, i) => orbitEntrance(i, false).from.rotateY);
for (let i = 1; i < angles.length; i++) {
  assert.ok(angles[i] < angles[i - 1], `tile ${i} should start shallower than ${i - 1}`);
  assert.ok(angles[i] > 0, `tile ${i} should still be on the curve`);
}

// Depth follows the same shape, and nothing starts in front of the viewer.
for (let i = 0; i < ORBIT_MAX; i++) {
  assert.ok(orbitEntrance(i, false).from.z < 0, `tile ${i} must start behind the plane`);
}

// Stagger is monotonic, and the whole arc stays inside a second — past that it
// stops reading as one movement and starts reading as a slow list.
const last = orbitEntrance(ORBIT_MAX - 1, false);
assert.ok(last.delay > first.delay, "stagger must increase");
assert.ok(last.delay < 0.7, `the last staggered tile starts at ${last.delay}s — too late`);

// ── The cap ──────────────────────────────────────────────────────────────────
// This is the one that protects a 2,067-file folder. Past the cap there is no
// transform at all, not merely a smaller one.
for (const i of [ORBIT_MAX, ORBIT_MAX + 1, 500, 9298]) {
  const beyond = orbitEntrance(i, false);
  assert.deepEqual(beyond.from, { opacity: 0 }, `tile ${i} must get no transform`);
  assert.deepEqual(beyond.to, { opacity: 1 }, `tile ${i} must only fade`);
  assert.equal(beyond.delay, 0, `tile ${i} must not be staggered`);
}

// ── Reduced motion ───────────────────────────────────────────────────────────
// A reduced rotation is still a rotation. Opacity only, at every index.
for (const i of [0, 1, 10, 1000]) {
  const reduced = orbitEntrance(i, true);
  assert.deepEqual(reduced.from, { opacity: 0 }, `index ${i} must not rotate under reduced motion`);
  assert.deepEqual(reduced.to, { opacity: 1 });
  assert.equal(reduced.delay, 0);
}

console.log("check-motion-3d: all assertions passed.");
