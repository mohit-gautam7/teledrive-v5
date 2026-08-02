# Hosting TeleDrive

## The short version

**Vercel's free tier cannot carry this workload. Move the app to an always-on VM
— Oracle Cloud Always Free is the best free option.**

The blocker is not CPU or cleverness, it is *bandwidth*. TeleDrive never hands a
Telegram URL to the browser (it embeds the bot token), so every downloaded byte
is proxied through the server. On Vercel Hobby that meters against a 100 GB /
month allowance. One user downloading a 2 GB file fifty times ends the month.

## Vercel Hobby, measured against what this app does

| Limit | Hobby | What TeleDrive does |
| --- | --- | --- |
| Bandwidth | 100 GB / month | Every download and every video seek is proxied. ~50 × 2 GB downloads exhausts it. |
| Function CPU | 4 CPU-hours / month | Streaming is I/O-bound but not free; thumbnails via `sharp` are pure CPU. |
| `maxDuration` | 60 s (Hobby) | A 2 GB download over a slow link cannot finish inside one invocation. |
| Long-lived processes | none | An MTProto session must re-handshake on every invocation (~1–2 s each). |
| Commercial use | prohibited | Hobby is non-commercial only; any monetisation requires Pro. |

The 60-second ceiling is the sharpest edge. `app/api/download/[id]` declares
`maxDuration = 300`, which Hobby silently clamps — so large downloads are cut
off mid-stream rather than failing cleanly.

## Options considered

| Platform | Free tier | Verdict |
| --- | --- | --- |
| **Oracle Cloud Always Free** | 2 OCPU / 12 GB ARM (halved from 4/24 in June 2026), 200 GB block storage, **10 TB/month egress**, always on | **Recommended.** 100× Vercel's bandwidth, no request timeout, and a persistent process for MTProto. |
| Fly.io | 3 shared-CPU VMs, but egress billed after a small allowance | Good runtime, wrong economics — bandwidth is the constraint. |
| Render | Free web service sleeps after 15 min idle, 100 GB egress | Cold starts break uploads mid-flight. |
| Railway | Trial credit, then paid | Not a free tier. |
| Cloudflare Workers | Generous requests, but 128 MB memory and no raw TCP | Cannot run MTProto; streaming proxy is awkward. |
| Keep Vercel + add a worker | — | Viable, but then you run a VM anyway; two moving parts instead of one. |

Oracle's Always Free allowance was quietly halved to 2 OCPU / 12 GB on
15 June 2026. That is still ample here: the app is I/O-bound, and 12 GB is far
more than the 1 GB a Vercel function gets.

## Migrating to Oracle Cloud Always Free

Everything the migration needs is in the repo: `Dockerfile` (ARM-ready, Debian
slim so `sharp` uses its prebuilt glibc arm64 binary), `docker-compose.yml`, and
`Caddyfile` for automatic HTTPS.

**This step needs your Oracle account, so it is the one thing left for you.**

1. **Create the instance** — OCI console → Compute → Instances → Create.
   Shape `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 22.04 (ARM).
   Save the SSH key. If you hit "Out of capacity", retry in another
   availability domain; it is a known constraint on the free ARM pool.

2. **Open the ports** — in the subnet's security list add ingress on TCP 80 and
   443 from `0.0.0.0/0`, then on the box itself:
   ```bash
   sudo iptables -I INPUT 1 -p tcp --dport 80  -j ACCEPT
   sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
   Oracle's Ubuntu images ship a restrictive iptables; forgetting this is the
   usual reason a correctly deployed app looks dead.

3. **Install Docker**
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```

4. **Point DNS first** — an A record for `APP_DOMAIN` at the instance's public
   IP. Do this *before* deploying: Caddy requests the certificate on first
   request, and the deploy script's last step verifies the domain end to end.

5. **Deploy**
   ```bash
   git clone https://github.com/mohit-gautam7/teledrive-v5.git && cd teledrive-v5
   cp .env.example .env && nano .env      # add APP_DOMAIN too
   ./scripts/deploy.sh
   ```

   `scripts/deploy.sh` is the whole deployment in one command. It checks `.env`
   for the values the app cannot start without, applies the schema, builds and
   starts the containers, waits for the healthcheck, and re-points the Telegram
   webhook at the new host. It is safe to re-run — the DDL is idempotent and the
   webhook registration just overwrites whatever URL Telegram currently holds.

   For routine redeploys afterwards:
   ```bash
   ./scripts/deploy.sh --pull --no-schema
   ```

   The schema step runs in a throwaway `node:20-slim` container, so the VM never
   needs a Node toolchain of its own. If you would rather run it from a machine
   that has one, `pnpm db:sync` does exactly the same thing (see below).

   If the webhook step fails, the app is still running — Telegram just could not
   reach it. Almost always that is DNS not yet propagated or ports 80/443 still
   closed (step 2). Fix and re-run.

### Cloudflare in front (free, recommended)

Oracle's 10 TB/month egress is generous but not infinite, and the VM is a single
box on the public internet. Cloudflare's free plan fixes both for nothing:

1. Add the domain to Cloudflare and switch the nameservers at your registrar.
2. Set the `APP_DOMAIN` A record to the VM's IP with the **orange cloud on**
   (proxied).
3. SSL/TLS mode → **Full (strict)**. Caddy already serves a real Let's Encrypt
   certificate, so strict validation passes and the hop stays encrypted.

What this buys:

- **Cached bytes never touch the VM.** Static assets and any download served
  with a cacheable response come from Cloudflare's edge instead of your egress
  allowance.
- **The origin IP stops being public**, which removes the easiest way to bypass
  or flood the box.
- **Free TLS termination at the edge** and HTTP/3 for clients that support it.

Two settings matter for this app specifically:

- **Do not enable "Cache Everything" globally.** Downloads are authenticated per
  user; a blanket cache rule would serve one user's file to another. Cache by
  extension or path only.
- Free-plan Cloudflare has a **100 MB request-body limit**. That is far above the
  10–50 MB upload chunks this app uses, so uploads are unaffected — but it is the
  reason chunk size should not be raised past ~50 MB while proxied.

### Database

Supabase stays as-is — it is a managed Postgres and moving compute does not
change that. One change is worth making: the `connection_limit=1` +
transaction-pooler setting exists because serverless spawns an unbounded number
of isolated clients. A single always-on process pools properly, so on the VM you
can raise it (`?pgbouncer=true&connection_limit=5`) and get real concurrency.

### Schema changes

`prisma db push` cannot introspect this Supabase project — it fails with P4002
on the pre-existing `public.profiles → auth.users` cross-schema foreign key,
which is unrelated to TeleDrive. `pnpm db:sync` applies the same additive DDL
directly (`scripts/schema.sql`, every statement `IF NOT EXISTS`).

## If you stay on Vercel

It works, and it is what is deployed today — just know the shape of it:

- Bandwidth is the ceiling. Watch the usage graph, not the invocation count.
- Set `maxDuration` honestly. `download`/`stream` claim 300 s; Hobby gives 60.
- Large-file MTProto uploads still work (parts are pushed across many short
  requests) but each one pays a fresh MTProto handshake, so a 2 GB upload takes
  roughly 20–30 minutes.
- Move before you monetise — Hobby forbids commercial use.
