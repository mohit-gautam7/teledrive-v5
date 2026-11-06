# Backup and recovery

TeleDrive keeps the **bytes** in Telegram and the **index** in PostgreSQL. Those
fail differently, and it is worth being blunt about which one this document is
for:

- Lose Telegram, lose the files. Nothing here recovers them.
- Lose PostgreSQL, and the files still exist in Telegram but nothing can find
  them: no filenames, no folders, no message ids. **The database is small, and
  it is the part that is genuinely irreplaceable.**

The whole thing was 18 MB on 19 September 2026 — 9,298 files across 67 GB of
Telegram storage. Backing it up costs nothing. Not backing it up cost this
project a week.

## What runs automatically

`docker-compose.yml` includes a `backup` service: a nightly `pg_dump -Fc` into
`./backups` on the host, keeping `BACKUP_KEEP_DAYS` (default 14) of them. It is
in the compose file rather than a host crontab so that a rebuilt VM starts
backing itself up again without anyone remembering to reinstall anything.

Each dump is written to `*.part` and renamed only on success, so a dump
interrupted by a reboot cannot be mistaken for a complete one.

Check on it:

```bash
docker compose logs backup | tail
ls -lh backups/
```

### Getting a copy off the box

A backup on the same disk as the database is not a backup of the disk dying.
Pick one and actually do it:

```bash
# To your laptop, on a schedule you control
rsync -az --delete vm:/opt/teledrive/backups/ ~/teledrive-backups/

# Or to any object store with a free tier
rclone copy /opt/teledrive/backups remote:teledrive-backups
```

The dumps contain file *metadata* — names, sizes, folder structure, Telegram
message ids — and the encrypted MTProto session strings. Treat a dump as
sensitive: it is not the files, but it is a map of them.

## Taking one by hand

```bash
docker compose exec -T db pg_dump -U teledrive -d teledrive \
  --no-owner --no-acl -Fc > "teledrive-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Against a managed database instead, with no local `pg_dump` installed — the
image matches the server version, which avoids the commonest failure:

```bash
docker run --rm -e PGURL="$DATABASE_URL" -v "$PWD:/backup" postgres:17-alpine \
  sh -c 'pg_dump "$PGURL" --schema=public --no-owner --no-acl -Fc -f /backup/teledrive.dump'
```

## Verifying one — the step people skip

A dump you have never restored is a file, not a backup. This takes two minutes:

```bash
docker run -d --name verify -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify postgres:17-alpine
until docker exec verify pg_isready -U postgres -d verify; do sleep 1; done

# The policies on `profiles`/`user_state` call auth.uid(), which vanilla
# Postgres has no schema for. Stub it or expect a few harmless restore errors.
docker exec verify psql -U postgres -d verify -c \
  "create schema if not exists auth;
   create or replace function auth.uid() returns uuid language sql stable as \$\$ select null::uuid \$\$;
   create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);"

docker cp teledrive.dump verify:/tmp/t.dump
docker exec verify pg_restore -U postgres -d verify --no-owner --no-acl /tmp/t.dump

# The numbers that matter: they must match production.
docker exec verify psql -U postgres -d verify -c \
  'select (select count(*) from "File") files,
          (select count(*) from "Chunk") chunks,
          (select count(*) from "Folder") folders,
          (select count(*) from "User") users'

# And the mapping back to Telegram, which is the whole point of the index.
docker exec verify psql -U postgres -d verify -c \
  'select count(*) filter (where "telegramFileId" is not null) with_file_id,
          count(*) filter (where "isChunked") chunked,
          pg_size_pretty(sum(size)) bytes from "File"'

docker rm -f verify
```

If the counts match and `chunks_without_file` is zero, the dump is good.

## Recovering the whole service from zero

Assumes nothing survives but a dump and the repository. Roughly 20 minutes.

**1. A VM.** Any Linux box with Docker. Two cores and 2 GB of RAM is plenty;
the constraint is bandwidth, not compute.

**2. The code and the secrets.**

```bash
git clone https://github.com/mohit-gautam7/teledrive-v5.git /opt/teledrive
cd /opt/teledrive
cp .env.example .env    # fill it in — see DEPLOYMENT.md for what each value is
```

`JWT_SECRET` and `SESSION_ENCRYPTION_KEY` must be **the same values as before**.
A new `JWT_SECRET` signs everyone out, survivable. A new
`SESSION_ENCRYPTION_KEY` makes every stored MTProto session undecryptable, and
each linked account has to be re-authorised by hand. Keep both somewhere other
than the box they run on.

**3. Bring up the database alone, and restore into it.**

```bash
docker compose up -d db
until docker compose exec -T db pg_isready -U teledrive; do sleep 1; done

# --clean --if-exists because a fresh volume is not empty: Postgres runs
# scripts/init-schema.sql on first boot, so every table already exists and a
# plain restore would fail on all of them. This drops each object immediately
# before recreating it from the dump.
cat teledrive-<timestamp>.dump | docker compose exec -T db \
  pg_restore -U teledrive -d teledrive --no-owner --no-acl --clean --if-exists
```

**4. Everything else.**

```bash
docker compose up -d --build
docker compose logs -f app
```

**5. Point DNS at the new address** and wait for Caddy to get a certificate
(`docker compose logs caddy`). Then re-register the Telegram webhook, which is
bound to the URL and does not move by itself:

```bash
curl -H "x-webhook-secret: $WEBHOOK_SECRET" https://<domain>/api/bot/setup
```

**6. Check it, in this order** — each step depends on the one before:

```bash
curl -fsS https://<domain>/api/health                 # app, database, Telegram
curl -fsS https://<domain>/api/auth/providers         # login routes are live
```

Then sign in and open a folder of files uploaded *before* the failure. If their
thumbnails render, the index and Telegram agree and the recovery is real.
Download one, and check the byte count matches what the listing claims.

## What a restored database does not restore

- **MTProto sessions may be dead.** Telegram invalidates a session key used from
  two places at once (`AUTH_KEY_DUPLICATED`), and moving to a new host looks
  exactly like that. The rows restore fine; the sessions may still need
  re-linking under Settings → Your Telegram account. Files stored through the
  bot — the overwhelming majority — are unaffected.
- **The Telegram webhook**, as above. Step 5 exists because forgetting it looks
  like "bot login is broken" rather than "the webhook points at a dead host".
- **Half-finished uploads.** Rows with `uploadStatus = 'uploading'` older than a
  day are swept on the next upload, by design. They were never complete files.
