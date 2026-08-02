#!/usr/bin/env bash
#
# One-command deploy for the always-on host (Oracle Cloud Always Free, or any VM).
#
#   ./scripts/deploy.sh              # build, start, sync schema, re-point webhook
#   ./scripts/deploy.sh --no-schema  # skip the one-time schema sync
#   ./scripts/deploy.sh --pull       # git pull first (routine redeploys)
#
# Safe to re-run: the schema DDL is idempotent and the webhook registration
# simply overwrites whatever URL Telegram currently holds.

set -euo pipefail
cd "$(dirname "$0")/.."

RUN_SCHEMA=1
PULL=0
for arg in "$@"; do
  case "$arg" in
    --no-schema) RUN_SCHEMA=0 ;;
    --pull) PULL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mx %s\033[0m\n' "$1" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
[ -f .env ] || die ".env is missing. Run: cp .env.example .env && nano .env"

command -v docker >/dev/null || die "docker is not installed. Run: curl -fsSL https://get.docker.com | sudo sh"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required."

# Only the values the app cannot start without. Optional integrations (Google
# sign-in, MTProto large files) are allowed to be blank so a minimal deploy works.
missing=()
for key in BOT_TOKEN DATABASE_URL JWT_SECRET WEBHOOK_SECRET NEXT_PUBLIC_APP_URL \
           NEXT_PUBLIC_TELEGRAM_BOT_USERNAME APP_DOMAIN; do
  value="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  [ -n "$value" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || die ".env is missing values for: ${missing[*]}"

set -a; . ./.env; set +a

if [ "$PULL" = "1" ]; then
  say "Pulling latest code"
  git pull --ff-only
fi

# ── Schema ────────────────────────────────────────────────────────────────────
# Runs in a throwaway container so the VM needs no Node toolchain of its own.
# `prisma db push` is deliberately not used here: it fails with P4002 against
# this Supabase project (see docs/DEPLOY.md).
if [ "$RUN_SCHEMA" = "1" ]; then
  say "Applying schema (additive, idempotent)"
  docker run --rm -v "$PWD:/app" -w /app --env-file .env node:20-slim \
    sh -c "npm install --no-save --silent pg@8 dotenv@17 && node scripts/apply-schema.mjs"
fi

# ── Build and start ───────────────────────────────────────────────────────────
say "Building and starting containers"
docker compose up -d --build

# ── Wait for health ───────────────────────────────────────────────────────────
say "Waiting for the app to become healthy"
for i in $(seq 1 60); do
  status="$(docker compose ps app --format '{{.Health}}' 2>/dev/null || true)"
  case "$status" in
    healthy) echo "app is healthy"; break ;;
    unhealthy) docker compose logs --tail 40 app; die "app reported unhealthy." ;;
  esac
  [ "$i" = "60" ] && { docker compose logs --tail 40 app; die "app did not become healthy in 5 minutes."; }
  sleep 5
done

# ── Re-point the Telegram webhook at this host ────────────────────────────────
# Done through the public domain rather than localhost: Telegram must be able to
# reach the same URL, so a success here also proves DNS and TLS are working.
say "Re-pointing the Telegram webhook to ${NEXT_PUBLIC_APP_URL}"
if curl -fsS --max-time 30 "${NEXT_PUBLIC_APP_URL%/}/api/bot/setup?key=${WEBHOOK_SECRET}"; then
  printf '\n'
else
  printf '\n\033[1;33m! Webhook registration failed.\033[0m\n'
  echo "  The app is running, but Telegram could not be pointed at it yet."
  echo "  Usual causes: DNS not yet propagated, or ports 80/443 closed in the"
  echo "  OCI security list / local iptables (see docs/DEPLOY.md step 2)."
  echo "  Re-run this script, or just visit:"
  echo "    ${NEXT_PUBLIC_APP_URL%/}/api/bot/setup?key=<WEBHOOK_SECRET>"
fi

say "Deployed. Logs: docker compose logs -f app"
