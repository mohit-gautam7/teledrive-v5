# Importing a large collection

For a one-off import of hundreds of gigabytes, **run TeleDrive on your own
machine and upload from there.** Not as a compromise — it is strictly better
than any host, and it costs nothing.

## Why no host is the right host for this

The thing people get wrong, and it is worth being precise about, is what the
hosting limit actually measures.

Your files are not stored on the web host. They are in Telegram. The host only
*passes bytes through*: your browser → the server → Telegram on the way up, and
Telegram → the server → your browser on the way down. A Telegram file URL
embeds the bot token, so it can never be handed to a browser directly; every
byte is proxied, and that is what the host meters.

So Render and Vercel are not capping you at "30–50 GB of files". They allow
**100 GB of bandwidth per month**, and a 231 GB import would spend 231 GB of
it — more than twice the monthly allowance, in one sitting, before anyone has
downloaded anything.

Run the same stack on your own machine and the middle hop disappears:

```
your disk → localhost:3000 → Telegram
```

Nothing crosses a metered link. There is no quota to exceed, no overage, and
no host to pay. The files land in exactly the same Telegram channel and the
same database rows as if you had uploaded them through the public site, so the
public site shows them the moment it is back up.

A host is still worth having afterwards, for reaching the drive from your
phone or from anywhere else. It just should not be carrying the initial import.

## What you need

- Docker Desktop running.
- `DATABASE_URL` pointing at the **real** database, not a local copy. This is
  the part that matters: the bytes go to Telegram either way, but the index
  must land in the database the public site reads, or you will have two drives
  that disagree.
- `JWT_SECRET` and `SESSION_ENCRYPTION_KEY` the same as production, or linked
  Telegram accounts will not decrypt.

## Running it

```bash
cp .env.example .env
```

Fill in `.env` with the production values, then:

```bash
docker compose up -d --build
```

Open `http://localhost:3000`, sign in, and drag your folders onto the page.

### Settings that matter for a big queue

| Setting | Value | Why |
|---|---|---|
| `UPLOAD_CHUNK_MB` | `16` | Vercel's 4.5 MB request cap is what forced 4. Locally there is no cap, and 16 cuts round-trips — and Telegram messages — by a factor of four. Stay at or below 16: a bot can *send* a 50 MB document but can only serve back 20 MB of one, so a larger chunk uploads fine and can never be downloaded. |
| Files at once (Settings) | `2`, then try `4` | Multiplies with `UPLOAD_CONCURRENCY` (3), so 2 already means six requests in flight. Raise it only if you are not seeing rate-limit errors. |
| `UPLOAD_CONCURRENCY` | leave at `3` | Chunks in flight per file. |

**Higher is not reliably faster.** Telegram answers a flood by lengthening the
next wait, so 8 files at once can finish a large queue *slower* than 2. If you
start seeing "Telegram is rate-limiting this account", drop back.

### Doing it in batches

The queue handles thousands of entries — 200 files enter it in under 40 ms —
but a browser tab is still the thing holding your file handles, and a tab that
dies takes the in-flight uploads with it. For a very large import, a few
hundred gigabytes at a time, folder by folder, is less annoying than one
enormous queue.

What survives what:

- **Navigating inside the app** — the upload never stops.
- **Reload or tab close, file over 4 MB** — reopens paused; Resume continues
  from the chunks the server already has.
- **Reload or tab close, file 4 MB or under** — gone from the queue, and there
  is nothing to resume: it is sent in one request, so no partial state exists
  on either side.
- **Machine sleeps** — the connection drops and uploads fail; Resume all picks
  them up. Worth disabling sleep for a long import.

### Checking it went in

```bash
docker compose exec -T db psql -U teledrive -d teledrive -c \
  'select count(*) files, pg_size_pretty(sum(size)) bytes from "File" where not "isDeleted"'
```

Against the hosted database instead, use the connection string in `.env`.

## After the import

Nothing to migrate. The bytes are in Telegram and the rows are in the database
the public site already reads, so the site shows the new files as soon as it is
running. Shut the local stack down:

```bash
docker compose down
```

The database volume stays on your machine unless you pass `-v`. If you pointed
`DATABASE_URL` at the hosted database, the local `db` container was never used
and holds nothing.

## Signing in locally

Bot-code login does not work on a local machine out of the box, and the reason
is worth knowing before you fight it.

Telegram delivers messages one of two ways: it calls a **webhook** (needs a
public HTTPS URL — localhost has none), or the app **polls** for updates. Dev
mode can poll, which is why `ENABLE_BOT_POLLING` exists. But the two are
mutually exclusive at Telegram's end, and polling starts by calling
`deleteWebhook` so that `getUpdates` is allowed to work.

So a local server with polling on **silently unregisters the production
webhook**, and bot login on the live site stops working until it is registered
again. That is not a bug in either one; it is Telegram allowing a bot exactly
one delivery method.

`ENABLE_BOT_POLLING=0` is therefore the right default, and local sign-in should
use the owner key instead:

```
OWNER_LOGIN_KEY=<something long>
OWNER_TELEGRAM_ID=<your Telegram user id>
```

`OWNER_TELEGRAM_ID` is the important half: it makes the owner key sign you in
as *your existing account*, so you see your real files rather than a new empty
drive. Then pick "Sign in with owner key" on the login page.

If you do want to test the bot flow locally, turn polling on, accept that the
live site's bot login is down meanwhile, and re-register the webhook afterwards:

```bash
curl -H "x-webhook-secret: $WEBHOOK_SECRET" https://<your-domain>/api/bot/setup
```

## What this does not solve

Downloads. Every byte anyone pulls out of the drive through the public site
still crosses the host and still counts against its allowance. Importing
locally keeps the *upload* off the meter; it does nothing about the *download*
side, which is the number to size a host against.

If the drive is mostly write-once and rarely read, a small host is fine. If you
intend to stream a 200 GB library back regularly, that is the figure to plan
for, and no free tier covers it.
