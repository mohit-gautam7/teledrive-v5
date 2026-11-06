# Oracle Always Free deployment status

Updated 2026-11-03. Target: zero-cost hosting, approximately 1 TB/month transfers.

## Verified locally

- Production build and TypeScript check passed.
- Upload routing, backoff and deduplication checks passed.
- Docker Compose configuration validated with placeholder variables.
- Production preview served HTTP 200 at `/`; anonymous `/api/files` returned 401.
- Telegram bot credential from `.env.local` passed Telegram getMe and the app health check.
- `.dockerignore` now excludes `.env.vercel`, other local environment files, keys, database dumps and local artifacts.
- `.env.example` now includes required POSTGRES_PASSWORD and documents a 16 MB VM chunk starting point compatible with bot downloads.

## Current blockers

1. Oracle console reached the saved account's login page. User reports losing the phone used for MFA, with no security key, and previously being unable to allocate Always Free CPU capacity. Account recovery through Oracle is required before deployment. No instance created and no paid resource ordered.
2. Existing public Vercel URL returns HTTP 404 DEPLOYMENT_NOT_FOUND.
3. Existing database pooler reports tenant/user not found through Prisma. Existing metadata must be recovered or its absence explicitly resolved before replacing the database.
4. Local Docker Engine is not running; no container build/runtime verification has been completed.

The shell inherits a BOT_TOKEN different from the project's local/Vercel configuration. Explicitly loading the project's `.env.local` for the local preview fixed Telegram authentication. Do not copy unrelated inherited environment variables to Oracle.

## Next execution steps

1. Sign into Oracle, inspect existing tenancy resources and free eligibility. Use only Always Free resources and do not upgrade the account.
2. Inspect Supabase project state; resume or correct connection settings as appropriate. Export metadata, verify its backup and preserve the existing session encryption key.
3. Create an eligible Ubuntu ARM A1 VM, up to 2 OCPU/12 GB RAM, initially 50 GB boot disk subject to the tenancy's aggregate free allowances. If free capacity is unavailable, stop provisioning rather than choosing paid compute.
4. Configure SSH and ports 80/443, keeping the database private. Select an existing domain or free subdomain once the IP is known.
5. Deploy the reviewed source and a private `.env` populated explicitly from the project's configuration. Set APP_DOMAIN and NEXT_PUBLIC_APP_URL to the final hostname; leave split-origin settings unset. Generate a new URL-safe Postgres password while preserving JWT/session-encryption keys required by existing data. Use 16 MB chunks and start with existing bounded concurrency.
6. Build and boot the Docker stack, restore metadata and verify `/api/health` returns 200 with both dependencies healthy.
7. Verify login, uploads, byte-identical downloads, media seeking and resume. Configure webhook/callback URLs only after HTTPS and dependencies pass.
8. Copy database backups off the VM, test restore and add usage monitoring. The intended 1 TB traffic level is a monitoring target, not an implemented application quota. No automated traffic cutoff has been implemented.

Do not report deployment complete until the public HTTPS site and an authenticated transfer round trip pass. Current local preview is diagnostic and is not a replacement public deployment.
