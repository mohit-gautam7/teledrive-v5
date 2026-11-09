/**
 * May this deployment claim the bot's webhook?
 *
 * Run: node scripts/check-webhook-target.mjs
 * Node strips the types; lib/webhook-target.ts imports nothing, so it loads as-is.
 *
 * The expensive mistake here is a false positive, not a false negative: a
 * preview build that registers takes the real bot away from production and
 * still looks healthy. So most of this file is about what must NOT register.
 */
import assert from "node:assert/strict";
import { webhookTarget } from "../lib/webhook-target.ts";

const prod = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://teledrive-codex.vercel.app",
  BOT_TOKEN: "t",
  WEBHOOK_SECRET: "s"
};

// The whole point: production registers, against the canonical domain.
assert.equal(webhookTarget(prod), "https://teledrive-codex.vercel.app/api/bot/webhook");

// A trailing slash must not produce a doubled one — Telegram would store the
// URL verbatim and every comparison afterwards would disagree forever.
assert.equal(
  webhookTarget({ ...prod, NEXT_PUBLIC_APP_URL: "https://teledrive-codex.vercel.app///" }),
  "https://teledrive-codex.vercel.app/api/bot/webhook"
);

// Previews must never claim it: the webhook is global to the bot, so this
// would silently point production's logins at a throwaway deployment.
assert.equal(webhookTarget({ ...prod, VERCEL_ENV: "preview" }), null);
assert.equal(webhookTarget({ ...prod, VERCEL_ENV: "development" }), null);
assert.equal(webhookTarget({ ...prod, VERCEL_ENV: undefined }), null);

// Self-hosted: no VERCEL, so NODE_ENV decides. Dev uses polling instead.
assert.equal(
  webhookTarget({ ...prod, VERCEL: undefined, NODE_ENV: "production" }),
  "https://teledrive-codex.vercel.app/api/bot/webhook"
);
assert.equal(webhookTarget({ ...prod, VERCEL: undefined, NODE_ENV: "development" }), null);
assert.equal(webhookTarget({ ...prod, VERCEL: undefined, NODE_ENV: undefined }), null);

// Missing credentials: registering without the secret would leave
// /api/bot/webhook accepting unauthenticated updates.
assert.equal(webhookTarget({ ...prod, WEBHOOK_SECRET: undefined }), null);
assert.equal(webhookTarget({ ...prod, BOT_TOKEN: undefined }), null);

// Telegram only accepts https. A misconfigured origin is left alone rather
// than turned into a call that always fails.
assert.equal(webhookTarget({ ...prod, NEXT_PUBLIC_APP_URL: "http://localhost:3000" }), null);
assert.equal(webhookTarget({ ...prod, NEXT_PUBLIC_APP_URL: "teledrive-codex.vercel.app" }), null);
assert.equal(webhookTarget({ ...prod, NEXT_PUBLIC_APP_URL: "   " }), null);
assert.equal(webhookTarget({ ...prod, NEXT_PUBLIC_APP_URL: undefined }), null);

console.log("webhook-target: all checks passed");
