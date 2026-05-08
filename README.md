# TeleDrive Personal

A personal cloud drive built with Next.js 14, Prisma, Supabase PostgreSQL, Telegram Login, Telegram Bot API, and GramJS MTProto (`telegram` on npm).

## Security First

The secrets pasted into chat must be rotated before deployment:

- Telegram bot token
- Telegram `API_ID` / `API_HASH`
- Supabase database password / connection string
- Supabase anon key if you consider it exposed
- `JWT_SECRET`

Never commit `.env.local`. This repo already ignores `.env*` files.

## Features

- Telegram Login Widget auth with HTTP-only JWT cookies
- Drive-style responsive UI with grid/list modes and dark mode
- Drag-and-drop multiple uploads
- Automatic routing:
  - videos: personal Telegram Saved Messages
  - images up to 50MB: bot channel
  - images above 50MB: personal Telegram
  - other files up to 50MB: bot channel
  - other files above 50MB: personal Telegram
- Folder creation and browsing
- File listing, soft delete, download, video streaming for bot-stored media
- Public share links
- Prisma schema for `User`, `StorageConfig`, `File`, `Folder`, and `Share`

## Environment

Create `.env.local` from `.env.example`:

```env
BOT_TOKEN=
BOT_CHANNEL_ID=
API_ID=
API_HASH=
TELEGRAM_SESSION=
SESSION_ENCRYPTION_KEY=
DATABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
JWT_SECRET=
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=
```

`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` is the bot username without `@`.

## Local Setup

```bash
pnpm install
pnpm prisma generate
pnpm db:push
pnpm dev
```

Open `http://localhost:3000`.

## Vercel Deployment

1. Push this repository to GitHub.
2. Import the repo in Vercel.
3. Add all `.env.example` variables in Vercel Project Settings.
4. Use Supabase's pooled PostgreSQL connection string for `DATABASE_URL` if available.
5. Run `pnpm db:push` locally once against the Supabase database, or run it from a secure CI job.
6. Deploy.

## Telegram Notes

Bot storage works with `BOT_TOKEN` and `BOT_CHANNEL_ID`. Add the bot as an admin to the private channel.

Personal storage uses GramJS through the npm package named `telegram`. To upload large media to Saved Messages on Vercel, provide a valid `TELEGRAM_SESSION`. Generating that session requires an OTP flow; this MVP stores the session string if you provide it in env or through the storage settings API.

Vercel free tier can time out on very large uploads. The code keeps the routing architecture compatible with a future VPS worker for 500MB-2GB uploads and long-range MTProto streaming.
