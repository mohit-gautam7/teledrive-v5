# TeleDrive — Personal Cloud on Telegram

A private, self-hostable cloud drive that stores your files in **your own Telegram** — up to 2 GB per file, free. Sign in with a one-time code from a Telegram bot; every file you upload is chunked and sent to your own chat with the bot, so your data lives in your Telegram account, under your control.

## Features

- **Telegram login** — message the bot, get a 6-digit code, sign in. No passwords.
- **Your storage** — files are stored in each user's own Telegram chat with the bot.
- **Big files** — up to 2 GB per file via chunked upload (4 MB chunks).
- **Fast browsing** — paginated listing, resized WebP thumbnails cached for a year, instant localStorage paint.
- **Folders** — nested folders with recursive size + item counts.
- **Files** — rename, move, favorite, share via public link, download, preview.
- **Bulk actions** — multi-select to download, move, favorite, or delete.
- **Sort & filter** — by date / name / size, filter by images / videos / documents.
- **Trash** — soft-delete with restore, and one-click empty trash.
- **Keyboard shortcuts** — `Esc` clear selection, `Ctrl/⌘+A` select all, `Del` trash.
- **Multi-user** — anyone can sign up; each user only ever sees their own files.

## Tech

Next.js 14 (App Router) · TypeScript · Prisma + PostgreSQL · Telegram Bot API + MTProto (legacy) · sharp · Tailwind · Framer Motion. Deploys on Vercel's free tier with a free Supabase Postgres database.

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy its token.
2. **Create a Postgres database** (e.g. a free [Supabase](https://supabase.com) project). Use the **transaction pooler** connection string (port `6543`) for the app.
3. **Copy `.env.example` to `.env.local`** and fill it in (see below).
4. Install and push the schema:
   ```bash
   pnpm install
   pnpm db:push
   pnpm dev
   ```
5. In development the bot is driven by long-polling automatically. In production, register the webhook once after deploying:
   `https://<your-domain>/api/bot/setup?key=<WEBHOOK_SECRET>`

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | yes | From @BotFather. |
| `DATABASE_URL` | yes | Postgres. On serverless use the transaction pooler (`:6543`, `?pgbouncer=true&connection_limit=1`). |
| `JWT_SECRET` | yes | Long random string for signing login cookies. |
| `WEBHOOK_SECRET` | yes | Long random string; protects the webhook + setup route. |
| `NEXT_PUBLIC_APP_URL` | yes | Public URL of the deployed app. |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | yes | Bot username without `@`. |
| `API_ID`, `API_HASH`, `TELEGRAM_SESSION`, `BOT_CHANNEL_ID`, `SESSION_ENCRYPTION_KEY` | no | Legacy only — for recovering files uploaded by older versions. |

> **Never commit real secrets.** `.env*` files are gitignored; only `.env.example` (with blank values) is tracked.

## Deploy (Vercel + Supabase, free)

1. Push this repo to GitHub and import it in Vercel.
2. Add the environment variables above in Vercel → Settings → Environment Variables.
3. Deploy, then visit `/api/bot/setup?key=<WEBHOOK_SECRET>` once to register the Telegram webhook.

The build runs `prisma generate && next build`. Apply schema changes with `pnpm db:push` from a machine that has `DATABASE_URL` (session-mode `:5432` works well for migrations).

## Notes

- The first time an image thumbnail is viewed it's generated from the original and cached; afterwards it loads instantly.
- Supabase free-tier databases pause after ~1 week idle — keep them warm with a scheduled ping if you rely on uptime.

## License

MIT — do what you like; no warranty.
