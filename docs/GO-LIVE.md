# Going live on Vercel + Render

The split is described in `docs/DEPLOY.md`. This is the order to actually do it
in, with the commands and your real values filled in.

| | URL |
| --- | --- |
| App origin (Vercel) | `https://teledrive-codex.vercel.app` |
| File origin (Render) | `https://teledrive-v5.onrender.com` |

Both projects already exist and are connected to the repo, so this is a push and
two environment variables — not a fresh set-up.

## Why the duplicate prompt never appeared

Confirmed, not guessed: `https://teledrive-codex.vercel.app/api/upload/check`
returns **404** while the app itself loads normally. That route shipped in 1.1.0.
The live Vercel build predates it, so the client asked a route that does not
exist, got an HTML 404, and threw — into a `catch {}` that said nothing. Deploying
is the fix; 1.2.0 makes sure the same class of failure can never be silent again.

---

## 1. Build it locally first

Not optional. This change touches auth, the CSP and every upload and download
path, and a type error would otherwise surface as a failed Render build ten
minutes from now.

```bash
pnpm install
pnpm check          # tsc --noEmit — this is the one that matters
pnpm build
node scripts/check-dedupe.mjs
```

`pnpm check` must be clean before you go further. If it is not, send me the
output rather than working around it.

## 2. Apply the database schema

The `File.contentHash` column may not be on the live database — it ships in
`scripts/schema.sql`, not in a migration that runs on deploy.

```bash
pnpm db:sync
```

Additive and idempotent (every statement `IF NOT EXISTS`), so it is safe against
a database that already has it. Do **not** use `prisma db push` — it fails with
P4002 on this Supabase project for reasons unrelated to TeleDrive.

## 3. Push

```bash
git add -A
git commit -m "Fix silent duplicate check; split file traffic to a second origin"
git push
```

Render's blueprint has `autoDeploy: true` and Vercel deploys on push, so both
start building here. Let them finish before step 4.

## 4. Set the two variables

**Vercel** → project → Settings → Environment Variables → Production:

```
NEXT_PUBLIC_FILE_ORIGIN = https://teledrive-v5.onrender.com
```

**Render** → `teledrive-v5` → Environment:

```
CORS_ALLOWED_ORIGINS = https://teledrive-codex.vercel.app
```

No trailing slashes. Each goes on **one** side only — setting
`NEXT_PUBLIC_FILE_ORIGIN` on Render would make that deployment send its own users
to itself by absolute URL and then fail its own CORS check.

While you are in Render's environment, confirm these match Vercel exactly:

- `JWT_SECRET` — byte for byte. A mismatch shows up as the app working perfectly
  and every single file request 401ing.
- `DATABASE_URL` — the same Supabase transaction-pooler URL (`:6543`).

## 5. Redeploy Vercel, restart Render

`NEXT_PUBLIC_FILE_ORIGIN` is inlined into the browser bundle at **build** time, so
a restart does nothing:

```bash
vercel --prod
```

`CORS_ALLOWED_ORIGINS` is read at runtime by `middleware.ts`, so Render only needs
**Manual Deploy → Restart service**.

## 6. Point the Telegram webhook at Vercel

`/api/bot/webhook` is a light route and stays on the app origin. It can only
point at one host:

```bash
curl -s "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://teledrive-codex.vercel.app/api/bot/webhook" \
  --data-urlencode "secret_token=$WEBHOOK_SECRET"
```

## 7. Verify

1. **Version is live.** Open `https://teledrive-codex.vercel.app/api/upload/check`
   signed in. Expect `"version":"1.2.0"`, a recent `builtAt`, and
   `"contentHashColumn":true`. If it still 404s, the deploy did not land. If
   `contentHashColumn` is `false`, step 2 did not take.
2. **Duplicates prompt.** Upload a file, then upload the same file again into the
   same folder. Skip / Replace / Keep both should open. If it does not, the
   console now names the reason — look for `[upload] duplicate check failed`.
3. **Traffic is split.** Devtools → Network, open a folder with images, download
   something. Thumbnails, uploads and downloads should show
   `teledrive-v5.onrender.com`; `/api/files`, `/api/folders` and
   `/api/upload/check` should show `teledrive-codex.vercel.app`.
4. **Video seeks.** Open a video and drag the scrub bar. Seeking uses Range
   requests across the origin, which is the part CORS most often gets wrong.

## When something is wrong

| Symptom | Cause |
| --- | --- |
| Requests to the Render host fail with nothing in the console | CSP. `NEXT_PUBLIC_FILE_ORIGIN` was not set *before* the Vercel build ran — set it, then redeploy. |
| Every file request 401s, rest of app fine | `JWT_SECRET` differs between the two deployments. |
| Preflight (`OPTIONS`) 403s | `CORS_ALLOWED_ORIGINS` does not exactly match the Vercel origin — check for a trailing slash. |
| First upload after a quiet spell hangs ~40 s | Render free tier waking. Expected; a 10-minute cron on `/` avoids it. |
| Duplicate dialog still absent | `GET /api/upload/check` — it distinguishes "not deployed" from "no column" from "working". |

## Rolling it back

Clear `NEXT_PUBLIC_FILE_ORIGIN` on Vercel and redeploy. Everything returns to a
single origin and Render keeps running as an independent full deployment. Nothing
in the database changes either way, so the duplicate fix survives the rollback.
