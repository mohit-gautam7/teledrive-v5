# Deployment tasks

Oracle Always Free selected by user. Local preparation in progress; remote deployment awaits Oracle sign-in.

## 1. Select and provision hosting
- [x] Confirm zero-cost budget and approximately 1 TB monthly usage target.
- [ ] Sign in to Oracle and inspect existing resources/free capacity in the home region.
- [ ] Provision only an Always Free eligible Ubuntu A1 VM (up to 2 OCPU/12 GB), SSH keys and restricted network access.
- [ ] Select a free hostname or existing domain; add transfer monitoring.
Acceptance: all resources are Always Free eligible and within aggregate free allowances; SSH and DNS work.
Verification: inspect console eligibility/usage, then SSH/HTTPS reachability. No paid fallback.
Dependencies: Oracle sign-in and hostname selection. Files: deployment documentation. Scope: small.

## 2. Verify per-user storage and safe transfer configuration
- [ ] Audit ownership on upload/download/share/delete and encrypted session storage.
- [ ] Verify personal-account routing and shared bot behavior for two distinct users.
- [ ] Evaluate 16 MiB chunks and bounded concurrency; preserve 2/4 GiB native-file boundaries.
Acceptance: no cross-user access; bot chunks remain downloadable; resumable transfers survive interruptions within supported windows.
Verification: focused routing/backoff checks plus two-account integration tests.
Dependencies: none for local review; authorized test accounts for integration. Files: lib/upload-config.ts, lib/upload-limits.ts, relevant route/tests as identified; split fixes into small tasks. Scope: medium per fix.

## 3. Validate staging container stack
- [x] Run pnpm check and upload-routing, backoff and deduplication checks (passed).
- [x] Complete production build (passed; local workspace-root warning remains).
- [x] Validate Compose configuration using placeholder values (passed).
- [x] Exclude local credentials/backups from Docker context and document required Postgres variables.
- [ ] Build Docker image and validate Compose with production-shaped nonsecret settings.
- [ ] Verify HTTPS, login callbacks, health endpoint and restart behavior.
Acceptance: build/checks pass and app reconnects to persistent metadata after restart.
Verification: staging smoke tests and container health/log review without exposing secrets.
Dependencies: 1 and 2. Files: Dockerfile, docker-compose.yml, Caddyfile, deployment docs. Scope: medium.

## Checkpoint: staging ready
- [ ] Resolve failed checks before migrating or directing production traffic.

## 4. Protect and migrate metadata
- [ ] Recover existing Supabase access: current pooler reports tenant/user not found. Inspect project status and connection settings before declaring data unavailable.
- [ ] Capture existing database and securely preserve required encryption keys.
- [ ] Configure encrypted off-host backups, retention and failure alerts.
- [ ] Restore into an isolated database and verify file lookup/decryption.
Acceptance: loss of VM does not lose the only copy of metadata or keys; no migration data loss.
Verification: restore drill and row/file sample comparison.
Dependencies: 3. Files: docker-compose.yml, BACKUP.md, backup script if needed. Scope: medium.

## 5. Validate transfers and capacity
- [ ] Check byte-for-byte round trips, media seeking, resume, delete and sharing.
- [ ] Test size boundaries, Telegram flood waits and network interruption recovery.
- [ ] Measure representative concurrent transfers with CPU/RAM/disk/network monitoring.
Acceptance: no corruption/cross-user access; bounded memory and graceful queuing; measured initial beta capacity.
Verification: checksums, two-account tests and recorded workload measurements.
Dependencies: 3 and 4. Files: existing probe scripts and a results document; split discovered fixes. Scope: medium.

## 6. Cut over and monitor
- [ ] Point domain to VM and configure callbacks/webhook; stop conflicting old workers.
- [ ] Run production smoke tests and monitor a small beta before wider access.
- [ ] Retain known-good image/configuration and document rollback without discarding new metadata.
Acceptance: production core flows work; rollback is ready; backups and alerts operate.
Verification: production upload/download and health checks, backup success and rollback review.
Dependencies: 5 and available hosting/domain access. Files: deployment docs and environment configuration. Scope: small.
