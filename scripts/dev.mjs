#!/usr/bin/env node
/**
 * Start the dev server with the project's own secrets, not the machine's.
 *
 * A real environment variable outranks every `.env` file, by design and
 * correctly. The cost of that rule here is that one stale `BOT_TOKEN` left in
 * the Windows *user* environment silently shadows `.env.local` for every
 * `pnpm dev`, on every branch, forever. The failure it produces is
 * `BotApiError: Unauthorized` on thumbnails and downloads — which reads as a
 * broken session or an expired login, not as an environment problem, and has
 * cost several hours across sessions before anyone looked at `process.env`.
 *
 * So: for the keys below, if the project's `.env.local` has a value and the
 * inherited environment disagrees, the project's value wins *for this child
 * process only*. Nothing is written to the machine, nothing is printed, and
 * `next dev` still reads every other variable the normal way.
 *
 * This is deliberately not a general "env files beat env vars" override. It
 * covers the handful of credentials that identify which Telegram bot and which
 * database this checkout talks to, where picking the wrong one is never what
 * anybody wanted.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Keys where a stale machine-wide value is always a mistake, never a choice. */
const OWNED_BY_PROJECT = [
  "BOT_TOKEN",
  "API_ID",
  "API_HASH",
  "JWT_SECRET",
  "SESSION_ENCRYPTION_KEY",
  "DATABASE_URL"
];

/** Minimal .env reader: KEY=VALUE, optional quotes, # comments, no expansion. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Later files win, matching Next's own precedence among .env files.
const fromFiles = {
  ...readEnvFile(join(root, ".env")),
  ...readEnvFile(join(root, ".env.local")),
  ...readEnvFile(join(root, ".env.development.local"))
};

const env = { ...process.env };
const corrected = [];
for (const key of OWNED_BY_PROJECT) {
  const want = fromFiles[key];
  if (!want || env[key] === want) continue;
  if (env[key]) corrected.push(key);
  env[key] = want;
}

if (corrected.length) {
  // Names only. The values are the whole point of not printing them.
  console.log(
    `[dev] using this project's ${corrected.join(", ")} instead of the value inherited from your shell or Windows environment.`
  );
}

const child = spawn("next", ["dev", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true
});
child.on("exit", code => process.exit(code ?? 0));
