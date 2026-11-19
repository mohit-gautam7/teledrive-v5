# TeleDrive — your cloud drive, stored in your own Telegram

**Live site:** https://teledrive-codex1.vercel.app

TeleDrive looks and works like Google Drive, but every file is kept in **your
own Telegram account**. Telegram gives each account free, unlimited cloud
storage. TeleDrive puts folders, previews, search, uploads and phone backup on
top of it.

---

## How it works, in one picture

```
 Your browser / phone ──(file bytes)──►  Telegram  (your account, "Saved Messages"-style storage)
        │                                     ▲
        └──(names, folders, sizes)──► TeleDrive server ──(checks the file really arrived)
                                          │
                                     Postgres database
                               (the drive's table of contents)
```

- **Telegram holds the files.** Every file is a message in your own Telegram
  storage. Nothing is stored on TeleDrive's servers.
- **The database holds the map.** File names, folders, sizes, favourites,
  trash, and which Telegram message holds each file. That is how TeleDrive can
  show a normal folder tree for data that is really a list of messages.
- **The server is a gatekeeper, not a pipe.** Uploads go from your browser or
  phone straight to Telegram. The server only sees a small "this message is
  file X" note, checks with Telegram that the message is really that file, and
  marks the upload complete. A wrong or forged message id is refused.

## Signing in and linking Telegram

1. **Sign in** with a one-time code from the TeleDrive bot, the Telegram login
   button, Google, or the owner key.
2. **Link your Telegram account** (Settings → *Your Telegram account*) with a
   QR code or phone code. This is what lets your browser and phone upload
   straight into your Telegram. The session key is encrypted at rest.

> **Old bot storage.** Early versions stored files through a bot, cut into
> 4 MB pieces. Those files still open and download. They live in
> *Initial testing → bot*. New uploads always go to your own account.

## Uploading

- **Upload files**, **Upload folder** (the folder tree is recreated), or drag
  and drop anywhere. Drop onto a folder card to put files in that folder.
- Files up to **2 GB** each (**4 GB** with Telegram Premium).
- Several files upload at once. Each shows its percentage, speed and time left.

### Transfers page

The **Transfers** page in the sidebar lists everything moving right now, in four
groups: **Uploading now**, **Waiting**, **Paused or failed** and **Finished**.
**Pause all**, **Resume all** and **Cancel all** work on everything at once.
The badge on the sidebar shows how many are still going.

### What happens if you reload or close the tab mid-upload

A web page can only read your files while it is open, so a reload **pauses**
the upload. Nothing is lost:

| File was… | After reload |
|---|---|
| Finished | Safe in your drive. |
| Already in Telegram, not yet confirmed | Only needs confirming; it is not sent again. |
| Half-sent | That one file starts over. Telegram drops unfinished pieces. |
| Not started | Waits in **Paused**. |

**Getting it going again:**

- **Chrome / Edge, with a folder picked through *Upload folder* or dropped in:**
  the **first tap anywhere** on the page brings up Chrome's "Allow access?"
  prompt, and uploads continue. Choose **Allow on every visit** and later
  reloads continue **by themselves, with no tap at all**.
- **Files picked with *Upload files*, or browsers without folder access (Brave,
  Firefox, Safari):** tap **Resume all** and pick the same files or folder
  again. They are matched back automatically by path, name and size.

Moving around inside TeleDrive (Transfers, Settings, other folders) never
pauses anything. Only a reload or closing the tab does.

## Sending files to someone — "Send in Telegram"

Open a file's or folder's menu → **Send in Telegram**, then type a **@username**
or a **phone number**. A bare 10-digit number is taken as Indian, `+91`.

- The file is **forwarded Telegram-to-Telegram** from your account. Nothing is
  downloaded or re-uploaded, so even a 2 GB file arrives instantly.
- **Folders** send every file inside them, in path order, at most 100 per
  batch.
- A phone number is looked up without adding the person to your contacts.
  If no Telegram account uses that number, you are told so.
- Old bot-storage files cannot be forwarded. They are skipped, and the result
  says how many.

There are no public share links. Files only reach people you send them to.

## Phone backup (Android app)

The Android app backs up photos and videos into a TeleDrive folder you choose.
It uploads **directly from the phone to your Telegram**, even with the app
closed, using its own built-in Telegram client.

- Choose albums, Wi-Fi / mobile data, charging-only, and how often it checks.
- Files already backed up are skipped, matched by name, size and folder.
- **Signing out stops backup.** Nothing uploads while you are signed out. If
  backup was **on** when you signed out, it turns itself back on when you sign
  in again. If you had turned it **off**, it stays off.
- Moving or renaming the backup folder in the drive does not break backup. The
  folder is tracked by its id, not its name.

Full details: [PHOTO_BACKUP.md](PHOTO_BACKUP.md) and [BACKUP.md](BACKUP.md).

## Everything else

- **Folders**: nested, with total size and item counts. **Download a folder**
  as one zip, built while it streams, so even huge folders use little memory.
- **Previews**: photos and videos open in a full-screen viewer. Videos can seek
  without downloading the whole file.
- **Favourites and Trash**: Trash keeps deleted items until you restore
  them or empty it.
- **Search, sort, filter**: by name, date, size or type.
- **Select many**: download as one zip, move, favourite or delete.
- **Storage page**: how much you use, split by type, plus your largest files.
- **Keyboard**: `/` search, `Esc` clear selection, `Ctrl/⌘+A` select all,
  `Del` move to trash.
- **Multi-user**: anyone can sign up, and each person only ever sees their own
  files.

## Privacy and safety

- Your files live in **your** Telegram account. TeleDrive's database only knows
  names, sizes and where each file sits.
- Telegram session keys are encrypted at rest, and bot tokens never reach the
  browser.
- No public links. Sending is always to a person you name.

---

## For developers

**Tech:** Next.js (App Router) · TypeScript · Prisma + PostgreSQL (Supabase) ·
GramJS (MTProto, server and browser) · native Kotlin MTProto client on Android ·
Tailwind · hosted on Vercel.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Create a Postgres database, for example a free
   [Supabase](https://supabase.com) project. Use the **transaction pooler**
   connection string (port `6543`).
3. Copy `.env.example` to `.env.local` and fill it in (see below).
4. Install and run:
   ```bash
   pnpm install
   pnpm db:sync   # applies scripts/schema.sql — additive, safe to re-run
   pnpm dev
   ```
5. In production, register the bot webhook once:
   `https://<your-domain>/api/bot/setup?key=<WEBHOOK_SECRET>`

`pnpm check` type-checks the code. `pnpm test` runs `scripts/check-all.mjs`.

The Telegram login button only renders on a domain the bot owns. Send
`/setdomain` to @BotFather with the deployment's origin.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | yes | From @BotFather. |
| `DATABASE_URL` | yes | Postgres; on serverless use the pooler (`:6543`, `?pgbouncer=true&connection_limit=1`). |
| `JWT_SECRET` | yes | Long random string for login cookies. |
| `WEBHOOK_SECRET` | yes | Protects the webhook and setup route. |
| `NEXT_PUBLIC_APP_URL` | yes | Public URL of the app. |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | yes | Bot username without `@`. |
| `API_ID`, `API_HASH` | yes | From [my.telegram.org](https://my.telegram.org). Needed for account linking, direct upload and sending. |
| `SESSION_ENCRYPTION_KEY` | recommended | Encrypts stored Telegram sessions. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Google sign-in. Redirect: `<APP_URL>/api/auth/google/callback`. |
| `OWNER_LOGIN_KEY`, `OWNER_TELEGRAM_ID` | no | Owner-key login. |

> **Never commit real secrets.** `.env*` files are gitignored. Only
> `.env.example`, with blank values, is tracked.

### Where things live

| Path | What it does |
|---|---|
| `components/drive-app.tsx` | The drive UI: views, menus, uploads, sending, sign-out and backup resume. |
| `lib/upload-manager.ts` | Upload queue: parallel uploads, pause/resume, recovery after a reload. |
| `lib/upload-store.ts` | Remembers upload sessions and folder handles (localStorage + IndexedDB). |
| `lib/direct-upload.ts` | Browser → Telegram upload, and Send in Telegram (username / phone). |
| `lib/telegram-user.ts` | Server-side MTProto: checks that an uploaded message is the right file. |
| `app/api/upload/direct/[fileId]` | Confirms a direct upload after verifying it with Telegram. |
| `mobile/android/` | Android app (Capacitor) with the native backup uploader. |

More detail: [DEPLOYMENT.md](DEPLOYMENT.md), [BULK_UPLOAD.md](BULK_UPLOAD.md),
[SECURITY_AUDIT.md](SECURITY_AUDIT.md), [CHANGELOG.md](CHANGELOG.md).

## License

MIT. Do what you like; no warranty.
