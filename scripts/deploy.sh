#!/usr/bin/env bash
#
# One-command deploy for the always-on host (Oracle Cloud Always Free, or any VM).
#
#   ./scripts/deploy.sh              # build, start, wait for health, point the webhook
#   ./scripts/deploy.sh --pull       # git pull first (routine redeploys)
#   ./scripts/deploy.sh --migrate    # also run the additive schema sync
#
# Safe to re-run. The schema DDL is idempotent and the webhook registration
# overwrites whatever URL Telegram currently holds.
#
# The database lives in docker-compose.yml, so a brand-new volume gets its
# schema from scripts/init-schema.sql automatically on first boot — there is
# nothing to run for a fresh install. --migrate is for the other case: an
# existing database that needs columns added after a code change.

set -euo pipefail
cd "$(dirname "$0")/.."

RUN_SCHEMA=0
PULL=0
for arg in "$@"; do
  case "$arg" in
    --migrate) RUN_SCHEMA=1 ;;
    --pull) PULL=1 ;;
    --no-schema) ;;  # accepted and ignored: schema is no longer applied by default
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\n\033[1;33m! %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mx %s\033[0m\n' "$1" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
[ -f .env ] || die ".env is missing. Run: cp .env.example .env && nano .env"
command -v docker >/dev/null || die "docker is not installed. Run: curl -fsSL https://get.docker.com | sudo sh"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required."

# Only the values the app cannot start without. Optional integrations (Google
# sign-in, MTProto large files) are allowed to be blank so a minimal deploy works.
#
# DATABASE_URL is deliberately NOT here: docker-compose builds it from
# POSTGRES_* and overrides whatever .env carries, so requiring it would make
# people invent a value that is then ignored.
missing=()
for key in BOT_TOKEN POSTGRES_PASSWORD JWT_SECRET WEBHOOK_SECRET NEXT_PUBLIC_APP_URL \
           NEXT_PUBLIC_TELEGRAM_BOT_USERNAME APP_DOMAIN; do
  value="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  [ -n "$value" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || die ".env is missing values for: ${missing[*]}"

set -a; . ./.env; set +a

# Setting one half of the split-origin pair without the other breaks every file
# request in a way that reads as an auth bug. On a single box, neither belongs.
if [ -n "${NEXT_PUBLIC_FILE_ORIGIN:-}" ] || [ -n "${CORS_ALLOWED_ORIGINS:-}" ]; then
  warn "NEXT_PUBLIC_FILE_ORIGIN / CORS_ALLOWED_ORIGINS are set."
  echo "  Those are for the two-host split. This compose stack is a single"
  echo "  origin; leave both unset unless you know you want the split."
fi

if [ "$PULL" = "1" ]; then
  say "Pulling latest code"
  git pull --ff-only
fi

# ── Build and start ───────────────────────────────────────────────────────────
say "Building and starting containers"
docker compose up -d --build

# ── Schema, only when asked ───────────────────────────────────────────────────
# Runs inside the compose network so it reaches the database by service name —
# the container publishes no port, and it should not have to.
if [ "$RUN_SCHEMA" = "1" ]; then
  say "Applying additive schema changes (idempotent)"
  docker compose run --rm --no-deps \
    -e DATABASE_URL="postgresql://${POSTGRES_USER:-teledrive}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-teledrive}" \
    --entrypoint sh app \
    -c 'node -e "
      const { Client } = require(\"pg\");
      const fs = require(\"fs\");
      (async () => {
        const c = new Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        await c.query(fs.readFileSync(\"/app/scripts/schema.sql\", \"utf8\"));
        await c.end();
        console.log(\"schema up to date\");
      })().catch(e => { console.error(e.message); process.exit(1); });
    "' 2>/dev/null || warn "Schema sync skipped — run it by hand if a migration is pending."
fi

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

# ── Dependencies, not just liveness ───────────────────────────────────────────
# The container's own HEALTHCHECK only proves the process serves. This proves
# the database answers and the bot token is still valid, which are the two
# failures that look identical to a working deploy from the outside.
say "Checking dependencies"
if docker compose exec -T app node -e '
  fetch("http://127.0.0.1:3000/api/health")
    .then(async r => { const b = await r.text(); console.log(b); process.exit(r.status === 200 ? 0 : 1); })
    .catch(e => { console.error(e.message); process.exit(1); });
'; then
  :
else
  warn "The app is serving but a dependency is down — see the JSON above."
fi

# ── Re-point the Telegram webhook at this host ────────────────────────────────
# Through the public domain rather than localhost: Telegram must reach the same
# URL, so a success here also proves DNS and TLS are working. The secret goes in
# a header, not the query string, so it stays out of access logs and Referer.
say "Re-pointing the Telegram webhook to ${NEXT_PUBLIC_APP_URL}"
if curl -fsS --max-time 30 -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
     "${NEXT_PUBLIC_APP_URL%/}/api/bot/setup"; then
  printf '\n'
else
  warn "Webhook registration failed."
  echo "  The app is running, but Telegram could not be pointed at it yet."
  echo "  Usual causes: DNS not yet propagated, or ports 80/443 closed in the"
  echo "  cloud security list / local iptables (see DEPLOYMENT.md step 2)."
  echo "  Re-run this script once DNS resolves."
fi

say "Deployed. Logs: docker compose logs -f app"
