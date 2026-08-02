# Runs TeleDrive as a single always-on process — the deployment target that
# large uploads and streamed downloads actually need. Debian slim rather than
# Alpine: sharp ships prebuilt binaries for glibc arm64, and Oracle's Always
# Free tier is ARM (Ampere A1).

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prisma generate only parses the URL at build time; the real one is injected at
# runtime, so a placeholder keeps secrets out of the image.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

# NEXT_PUBLIC_* are inlined into the client bundle, so they must exist now.
ARG NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
ENV NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=$NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN pnpm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Prisma's query engine dynamically links libssl. node:20-slim omits it, so the
# engine cannot detect a version, warns on every boot, and falls back to a
# guessed openssl-1.1.x build. ca-certificates comes along for outbound TLS to
# Supabase and Telegram.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Any 2xx/3xx from the app root means the process is serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
