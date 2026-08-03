# TeleDrive — Personal Cloud on Telegram

A private, self-hostable cloud drive that stores your files in **your own Telegram** — up to 2 GB per file (4 GB with Premium), free. Sign in with a one-time code from a Telegram bot; every file you upload is chunked and sent to your own chat with the bot, so your data lives in your Telegram account, under your control.

## Features

- **Several ways in** — Telegram bot code, the one-tap Telegram Login Widget, Google sign-in (linked once to your Telegram account), or an owner key.
- **Your storage** — files are stored in each user's own Telegram chat with the bot. Bot tokens never reach the browser; every byte is proxied.
- **Big files** — 2 GB per file via chunked upload, or 4 GB by linking your own Telegram account (see below).
- **Resumable uploads** — a dropped connection costs the in-flight chunks, not the whole file. Re-sending a chunk that already landed is deduplicated. Closing the tab does not end an upload either: the session is kept for a day and picked up again on the next visit, sending only what is still missing.
- **Transfer panel** — uploads and downloads in one place, each with a percentage, live speed and ETA taken from byte deltas.
- **Folder download** — a folder, or several at once, streamed as a single zip with its nesting intact. The archive is built as it is sent, so a 20 GB folder costs no more memory than a small one.
- **Drag and drop** — drop files anywhere to upload, or drop them onto a folder card to file them there. Drag existing files onto a folder to move them.
- **Folder upload** — pick a directory and the folder tree is recreated as it uploads.
- **Share management** — list, disable, revoke, password-protect and expire every link from one place.
- **Storage insights** — total usage, breakdown by media type and backend, largest files.
- **Media lightbox** — full-bleed viewer with keyboard nav, swipe on touch, click-to-zoom, and range-based video seeking.
- **Open in Telegram** — jump straight to the chat holding a file.
- **Folders** — nested, with recursive size and item counts.
- **Files** — rename, move, favourite, share, download, preview, properties.
- **Bulk actions** — multi-select files *and* folders to download as one archive, or move, favourite and delete.
- **Sort & filter** — by date / name / size; filter by images / videos / documents.
- **Trash** — soft-delete with restore, and one-click empty trash.
- **Keyboard shortcuts** — `/` focus search, `Esc` clear selection, `Ctrl/⌘+A` select all, `Del` trash.
- **Multi-user** — anyone can sign up; each user only ever sees their own files.

## Two storage backends

| | Bot chat (default) | Your linked account |
| --- | --- | --- |
| Setup | none | authorise once with a QR code or phone code |
| Max file size | 2 GB | 2 GB, or 4 GB with Telegram Premium |
| How it is stored | one message per 4 MB chunk | one message, whole file |

Bot storage has to chunk because the Bot API can only *download* 20 MB per
object. Linking your own account (Settings → Your Telegram account) uses MTProto
instead, which stores a large file as a single message. Files at or above 64 MB
then use it automatically; `File.backend` records which one holds each file, so
existing files keep working either way.

> **A note on files stored before chunking.** A bot may *send* a 50 MB document
> but may only *fetch* 20 MB of one, so anything an early version stored as a
> single document above 20 MB went up fine and cannot come back down. Those files
> are marked **RE-UPLOAD** in the drive and answer downloads with an explanation
> rather than failing silently. Re-uploading them stores them in chunks, after
> which they work normally.

## Tech

Next.js 14 (App Router) · TypeScript · Prisma + PostgreSQL · Telegram Bot API + MTProto · sharp · Tailwind v4 · Framer Motion.

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy its token.
2. **Create a Postgres database** (e.g. a free [Supabase](https://supabase.com) project). Use the **transaction pooler** connection string (port `6543`) for the app.
3. **Copy `.env.example` to `.env.local`** and fill it in (see below).
4. Install and apply the schema:
   ```bash
   pnpm install
   pnpm db:sync
   pnpm dev
   ```
5. In development the bot is driven by long-polling automatically. In production, register the webhook once after deploying:
   `https://<your-domain>/api/bot/setup?key=<WEBHOOK_SECRET>`

> Local polling calls `deleteWebhook`. If a production deployment shares the same
> bot token, run the dev server with `ENABLE_BOT_POLLING=0` or it will take
> updates away from production.

### Enabling the one-tap Telegram Login Widget

The widget only renders on a domain the bot owns. Without this step Telegram
silently refuses to draw the button (the "bot domain invalid" case), so it is
required, not optional:

1. Message [@BotFather](https://t.me/BotFather) and send `/setdomain`.
2. Choose your bot.
3. Send the deployment's origin — scheme and host only, no path, e.g.
   `https://teledrive-codex.vercel.app`.

Register every origin you use (production and any preview domain). The login
page detects a missing domain and tells the user how to fix it, falling back to
the bot-code flow in the meantime. `localhost` cannot be registered — use the
bot code or the owner key in development.

### Linking a Telegram account for large files

Settings → *Your Telegram account* authorises your own account over MTProto
(QR code or phone number). Telegram rate-limits sign-in attempts aggressively:
repeated tries earn a flood wait measured in hours, and the UI now reports
exactly how long it is. `API_ID` / `API_HASH` must be set for this to appear.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | yes | From @BotFather. |
| `DATABASE_URL` | yes | Postgres. On serverless use the transaction pooler (`:6543`, `?pgbouncer=true&connection_limit=1`). |
| `JWT_SECRET` | yes | Long random string for signing login cookies. |
| `WEBHOOK_SECRET` | yes | Long random string; protects the webhook + setup route. |
| `NEXT_PUBLIC_APP_URL` | yes | Public URL of the deployed app. |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | yes | Bot username without `@`. |
| `API_ID`, `API_HASH` | for 2 GB+ | Telegram app credentials from [my.telegram.org](https://my.telegram.org). Enables account linking; without them only bot storage is available. |
| `SESSION_ENCRYPTION_KEY` | recommended | Encrypts stored MTProto sessions at rest. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Enables Google sign-in. Redirect URI: `<APP_URL>/api/auth/google/callback`. |
| `OWNER_LOGIN_KEY`, `OWNER_TELEGRAM_ID` | no | Owner-key login. |
| `TELEGRAM_SESSION`, `BOT_CHANNEL_ID` | no | Legacy only — recovering files from older versions. |

> **Never commit real secrets.** `.env*` files are gitignored; only `.env.example` (with blank values) is tracked.

## Schema changes

```bash
pnpm db:sync
```

`prisma db push` cannot introspect a Supabase project that has the default
`public.profiles → auth.users` foreign key (Prisma error P4002). `pnpm db:sync`
applies the same additive DDL directly from `scripts/schema.sql`; every
statement is `IF NOT EXISTS`, so it is safe to re-run and never drops anything.

## Deploying

**Vercel's free tier is not the right home for this app** — every download is
proxied through a function, so 100 GB/month of bandwidth is the binding limit.
See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the full comparison and a
step-by-step migration to an always-on VM (Oracle Cloud Always Free), including
the `Dockerfile`, `docker-compose.yml` and `Caddyfile` in this repo.

For how many concurrent users this actually supports and what degrades first,
see **[docs/SCALE.md](docs/SCALE.md)**.

## Notes

- The first time an image thumbnail is viewed it's generated from the original and cached in Telegram; afterwards it loads instantly.
- Supabase free-tier databases pause after ~1 week idle — keep them warm with a scheduled ping if you rely on uptime.

## License

MIT — do what you like; no warranty.
