# TeleDrive deployment plan

Updated 2026-11-03. User authorized Oracle Always Free deployment. Local preparation underway; no VM provisioned or production cutover performed yet.

## Objective and assumptions

Run the existing public multi-user Telegram drive on a strictly zero-cost hosting plan, targeting approximately 1 TB of monthly transfers. Use Oracle Always Free only, with no paid upgrades or trial-only resources. Domain and expected concurrent transfers remain unknown. Oracle login is pending in the user's browser; no local OCI CLI configuration is present.

No deployment can guarantee infinite throughput, users, or Telegram availability. Offer no application-wide cumulative storage quota only subject to Telegram limits and available service capacity. Preserve protective request/concurrency limits.

## Recommendation

Use one Oracle Always Free Ampere A1 instance, up to 2 OCPU and 12 GB RAM, Ubuntu 24.04 ARM64, initially a 50 GB boot volume within the account's free aggregate storage allocation. Confirm the console's Always Free eligibility and existing account usage before creation. Use the existing home region and available free capacity. If unavailable, report the capacity blocker instead of choosing a paid shape. Keep the account on Free Tier. Free outbound allowance is up to 10 TB/month; this is not unlimited.

Use an existing domain if available, otherwise select a free subdomain after the public IP is known. Configure HTTPS through Caddy. Keep off-server metadata backups on the user's computer. Add transfer monitoring with alerts at the intended 1 TB usage level and well before the free allowance; budget alerts alone do not enforce a spending cap. No paid services are authorized. Idle free instances may be reclaimed, so verify restore procedures.

## Existing implementation

- Next.js 15 / React, Prisma/PostgreSQL and GramJS; Dockerfile already builds a persistent standalone Node process.
- docker-compose.yml already defines app, PostgreSQL, Caddy HTTPS and local nightly database backups.
- Uploads flow browser -> app -> Telegram. Downloads reverse that path. Thus both uploading to Telegram and downloading to a browser create host outbound traffic.
- lib/upload-limits.ts enforces 2 GiB per logical file, or 4 GiB for linked Premium users. Bot mode stores separate chunk documents; MTProto assembles a native Telegram file. Larger logical files would require a separately designed multipart format, not simply removing validation.
- lib/upload-config.ts defaults to 4 MiB requests. Begin with 16 MiB only after verifying all bot download paths; remain below the code's 20 MiB hosted Bot API retrieval ceiling. Do not blindly apply the older documentation's 32 MiB suggestion.
- Per-user MTProto sessions and bot storage are already present. Audit routing and ownership before public access; linking an account alone does not force every small file into Saved Messages.
- Existing local backup copies do not protect against loss of the server. Add encrypted off-host copies and preserve the encryption key separately.

## Deployment architecture

Browser <-> HTTPS/Caddy <-> one persistent Next.js application <-> Telegram
                                      |
                                PostgreSQL volume
                                      |
                          encrypted off-host DB backups

Serve frontend and API on one origin. Initially use a single app process to preserve the current process-local session/rate-limit behavior. Use direct DNS to Caddy for transfer traffic. Keep PostgreSQL private. Container restart policy exists; monitor health and alert on failures. Store file metadata in PostgreSQL and file contents in Telegram. Metadata, thumbnails and backups still consume finite disk space.

## Execution order

1. Complete Oracle sign-in; inspect tenancy, Always Free capacity, existing resources and public hostname options.
2. Verify multi-user access boundaries and transfer reliability locally; retain safe limits.
3. Build and test the deployment image and configuration on a staging VM.
4. Back up/migrate metadata and configure encrypted off-host backups with restore verification.
5. Test real transfers and a small concurrent-user workload in staging.
6. Cut over DNS, callbacks and webhook after validation; retain the prior deployment for rollback.

Detailed acceptance criteria are in tasks/todo.md. Production deployment is authorized within the zero-cost requirement, subject to account access and verified free eligibility.

## Launch criteria and rollback

Require working login/linking, upload/download integrity, seeking, resume, deletion, user isolation and restore. Validate normal and Premium size boundaries with real authorized accounts. Record CPU, memory, disk, transfer throughput and Telegram flood waits during a representative beta workload. Do not promise a user capacity before measurements.

Before cutover capture the database, encryption keys and previous image/configuration. Stop conflicting old workers/webhooks/session owners. On regression restore the prior image/configuration and routing, preserving new metadata; avoid destructive database rollback. Expand public access only after the beta workload passes.

## Sources checked

- Oracle free allowance: https://www.oracle.com/cloud/free/
- Oracle resource constraints: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Oracle account verification and capacity: https://www.oracle.com/cloud/free/faq/
- Render outbound accounting and overages: https://render.com/docs/outbound-bandwidth
- Telegram file sharing: https://telegram.org/faq
- Telegram Premium file limits: https://telegram.org/faq_premium

Render's allowance is monthly outbound transfer, not a cap on total files stored in Telegram. Provider pages are mutable; recheck the exact order before purchase. Existing DEPLOYMENT.md contains older provider claims and is not the pricing authority for this plan.
