/**
 * Does a FLOOD_WAIT actually get honoured, and does the queue setting hold? (P1)
 *
 * Run: node scripts/check-backoff.mjs
 *
 * Both of these are silent when wrong. A mis-parsed Retry-After does not throw —
 * it retries immediately into a flood Telegram then lengthens, and the upload
 * looks merely slow. A concurrency value that fails to normalise reads as
 * `undefined`, which makes `running < undefined` false and stalls the queue
 * forever with everything "pending". Neither shows up in a type check.
 */
import assert from "node:assert/strict";
import { retryAfterMs, MAX_HONOURED_WAIT_MS } from "../lib/upload-config.ts";
import { normalise, DEFAULTS, UPLOAD_CONCURRENCIES } from "../lib/preferences.ts";

// ── Retry-After parsing ──────────────────────────────────────────────────────
assert.equal(retryAfterMs(null), null, "absent header means no server-named wait");
assert.equal(retryAfterMs(""), null, "empty header must not become Number('') === 0");
assert.equal(retryAfterMs("   "), null, "whitespace-only is not a delay of zero");
assert.equal(retryAfterMs("not-a-date"), null, "junk falls back to our own backoff");

assert.equal(retryAfterMs("30"), 30_000, "delta-seconds is the common form");
assert.equal(retryAfterMs(" 5 "), 5_000, "padded values still parse");
assert.equal(retryAfterMs("0"), 0, "zero is a legal, meaningful answer");
assert.equal(retryAfterMs("-10"), 0, "a negative delta clamps to now, never to null");

// HTTP-date form, both directions.
const future = new Date(Date.now() + 60_000).toUTCString();
const ms = retryAfterMs(future);
assert.ok(ms > 55_000 && ms <= 60_000, `HTTP-date should be ~60s, got ${ms}`);
assert.equal(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0, "a past date means retry now");

// The ceiling is what stops a worker sleeping through an hours-long FLOOD_WAIT.
assert.ok(retryAfterMs("3600") > MAX_HONOURED_WAIT_MS, "an hour must exceed the ceiling and fail loudly");
assert.ok(retryAfterMs("30") < MAX_HONOURED_WAIT_MS, "half a minute is worth waiting out");

// ── Concurrency preference ───────────────────────────────────────────────────
assert.equal(normalise({}).uploadConcurrency, DEFAULTS.uploadConcurrency, "absent falls back to the default");
assert.equal(normalise({ uploadConcurrency: 4 }).uploadConcurrency, 4, "a listed value survives");
assert.equal(normalise({ uploadConcurrency: "8" }).uploadConcurrency, 8, "localStorage round-trips numbers as strings");
for (const bad of [0, -1, 3, 99, null, undefined, "lots", NaN, {}]) {
  assert.equal(
    normalise({ uploadConcurrency: bad }).uploadConcurrency,
    DEFAULTS.uploadConcurrency,
    `${JSON.stringify(bad)} must not reach the queue as a limit`
  );
}
assert.ok(
  UPLOAD_CONCURRENCIES.includes(DEFAULTS.uploadConcurrency),
  "the default must itself be one of the offered options"
);
// Every offered option has to be a usable limit, or the settings menu can stall
// the queue the moment someone picks it.
for (const n of UPLOAD_CONCURRENCIES) {
  assert.ok(Number.isInteger(n) && n >= 1, `${n} is not a usable worker count`);
  assert.equal(normalise({ uploadConcurrency: n }).uploadConcurrency, n);
}

console.log("check-backoff: all assertions passed.");
