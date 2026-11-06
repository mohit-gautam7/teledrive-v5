# Deploying TeleDrive

Researched against current provider documentation on 19 September 2026. Offers
move; re-check before acting on the numbers.

## What this application actually needs

Start here, because most "free hosting" comparisons answer a different question.
TeleDrive is not CPU-bound or memory-bound. It has four real constraints:

1. **Egress.** Every downloaded byte is proxied through the server — a Telegram
   file URL embeds the bot token, so it can never be handed to a browser. One
   person re-watching a 2 GB video twenty-five times is 50 GB. This is the
   constraint that ends free tiers, and it is why the previous deployment was
   split across two of them.
2. **No request ceiling.** Uploads post multi-megabyte chunks; downloads stream
   for as long as the file takes. A 60-second function timeout or a 4.5 MB body
   cap is fatal, not inconvenient.
3. **A long-lived process.** GramJS holds an MTProto connection and a session.
   Serverless re-establishes it per invocation, which Telegram reads as session
   abuse and answers with `AUTH_KEY_DUPLICATED`.
4. **A database that does not pause itself.** Covered below, because it is what
   actually broke.

## The comparison

| | Egress/mo | Sleeps? | Request limit | Cost | Card? |
|---|---|---|---|---|---|
| **Oracle Cloud Always Free** | **10 TB** | No | None | Free, no expiry | Verification only |
| Heroku (Student) | fair-use | No on Basic | **30 s** | $13/mo credit, 24 mo | No |
| DigitalOcean (Student) | 1 TB | No | None | $100 credit, ~12 mo | Yes |
| Azure (Student) | 100 GB free | Varies | Varies | $100 credit, 12 mo | No |
| Vercel Hobby | 100 GB | No | 4.5 MB body, 60 s | Free | No |
| Render Free | 100 GB | **After 15 min** | None | Free | No |

### Recommended: Oracle Cloud Always Free

**10 TB of egress per month, free with no expiry date.** That is a hundred times
the Vercel and Render allowances, and it is the only number in the table that
makes the split-origin arrangement unnecessary. One box, one origin, one
deployment to keep in sync instead of two.

Current Always Free allowance is 2 OCPU and 12 GB of RAM on `VM.Standard.A1.Flex`
(halved from 4/24 on 15 June 2026, without announcement — worth knowing if you
read an older guide), plus 200 GB of block storage. Far more than this needs.

The honest caveats:

- **A card is required for identity verification.** Always Free resources do not
  charge it. Do not "upgrade to Pay As You Go" unless you mean it.
- **Capacity varies by region.** `Out of host capacity` is common in busy
  regions. Singapore and Frankfurt usually provision in minutes; Singapore is
  also the closest region to India, and is what the old Render service used.
- **Idle instances can be reclaimed.** Keep it in use, or check in occasionally.
- ARM (`aarch64`). The `Dockerfile` is already built for it — Debian slim rather
  than Alpine, because `sharp` ships prebuilt binaries for glibc arm64.

### If you would rather not hand over a card: Heroku

$13/month in credits for 24 months through the Student Pack. A Basic dyno ($7,
does not sleep, 512 MB) plus Essential Postgres ($5) is $12 — inside the
allowance, with no card and no provisioning lottery.

The catch is the **30-second router timeout**. Streaming downloads are fine, as
each byte resets a rolling 55-second window, and uploads are chunked. But a
chunk that meets a Telegram `FLOOD_WAIT` will exceed 30 s and be killed with an
H12. Set `UPLOAD_CHUNK_MB=2` there to keep chunks well inside the window; the
client reads the value from `/api/upload/init`, so changing it does not strand
an upload mid-resume. Credits expire after 24 months and do not renew.

### Not recommended, and why

- **Back to Vercel + Render.** It worked, and it cost two free tiers, two
  deployments to keep on the same commit, and a 15-minute cold start on every
  file operation after a quiet spell. Oracle removes the reason the split
  existed.
- **Cloudflare Workers.** No long-lived MTProto connection, and R2/Workers is a
  different storage model than the one this app is built on.
- **Neon for the database.** The free tier is 0.5 GB (ample — the database is
  18 MB) but only 100 compute-hours per month with scale-to-zero after 5 minutes
  idle. An always-on backend with a health check keeps the compute awake, which
  is ~730 hours. It would exhaust the allowance. Good for bursty apps; wrong for
  this one.

## About the database

The database is in `docker-compose.yml` as a container on the same box. That is
a deliberate change from the managed free tier this used to run on.

The managed tier paused itself after seven days of inactivity, and a paused
project stops resolving in DNS. The files were never at risk — they are in
Telegram — but the index that finds them was unreachable until someone clicked
Restore in a dashboard. It is 18 MB of data. It does not need a service with a
retention policy attached to it; it needs a volume and a nightly dump, which is
what `BACKUP.md` describes.

To use a managed database anyway, set `DATABASE_URL` in `.env` and delete the
`db` service and the `depends_on` block.

## Deploying to Oracle Cloud

**1. The instance.** Oracle Cloud console → Compute → Instances → Create.
Shape `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 24.04, region Singapore.
Save the SSH private key it offers — it is shown once.

**2. Open the ports.** Two places, and missing either presents as a site that
never loads:

```bash
# The instance's own firewall (Ubuntu images ship with this closed)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Then in the console: Networking → Virtual Cloud Networks → your VCN → Security
Lists → Default → Add Ingress Rules, source `0.0.0.0/0`, TCP 80 and 443.

**3. Docker.**

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

**4. The app.**

```bash
git clone https://github.com/mohit-gautam7/teledrive-v5.git /opt/teledrive
cd /opt/teledrive
cp .env.example .env
```

Fill in `.env`. The ones without which nothing works:

| Variable | Where it comes from |
|---|---|
| `POSTGRES_PASSWORD` | Invent one. `openssl rand -base64 32`. |
| `BOT_TOKEN` | @BotFather |
| `JWT_SECRET` | `openssl rand -hex 32` — **reuse the existing value** or everyone is signed out |
| `SESSION_ENCRYPTION_KEY` | **Reuse the existing value** or stored MTProto sessions become undecryptable |
| `WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `APP_DOMAIN` | The domain whose A record points at this VM |
| `NEXT_PUBLIC_APP_URL` | `https://` + that domain |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | The bot's @name, without the @ |
| `API_ID` / `API_HASH` | my.telegram.org — only for files over 20 MB via a linked account |

Because this is a single origin, leave `NEXT_PUBLIC_FILE_ORIGIN` and
`CORS_ALLOWED_ORIGINS` **unset**. They exist for the two-host split and setting
one without the other breaks file requests in a way that looks like an auth bug.

Chunk size can go up here. Vercel's 4.5 MB body cap is what forced
`UPLOAD_CHUNK_MB=4`; on a real host 16 is comfortable. Keep it under the
`request_body max_size` in the `Caddyfile`, or Caddy rejects the chunk before
the app sees it.

**5. DNS, then up.** Point an A record at the instance's public IP and let it
propagate *before* starting Caddy — Let's Encrypt validates over HTTP, and a
failed attempt is rate-limited.

```bash
docker compose up -d --build
docker compose logs -f
```

**6. Restore the data**, if this is a migration rather than a fresh install.
See `BACKUP.md`.

**7. Register the webhook.** Bound to the URL, so it must be redone on every
domain change:

```bash
curl -H "x-webhook-secret: $WEBHOOK_SECRET" https://<domain>/api/bot/setup
```

**8. Verify.**

```bash
curl -fsS https://<domain>/api/health
```

`{"ok":true}` means the app is up, the database answers, and the bot token is
still valid. Then sign in and open a folder of files that predate the migration:
if the thumbnails render, the index and Telegram agree.

## Decommissioning the old services

Not until all of these are true, in order: a verified backup exists; the new
deployment serves the drive; pre-migration files download correctly; a new
upload succeeds; and it has survived a `docker compose restart` and a full VM
reboot.

Then: Vercel project → Settings → Delete. Render service → Settings → Delete.
Leave Supabase until last and export it once more first — it is the only copy of
anything that has not been moved.
