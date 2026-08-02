# Deploying TeleDrive on Render (free)

Render runs the app as one always-on container built from the repo `Dockerfile`.
Unlike Vercel's free tier there is **no 4.5 MB request cap and no 60-second
timeout**, so large uploads and streamed downloads work. Bandwidth is ~100 GB/mo
(same ballpark as Vercel), and a free service **sleeps after ~15 minutes idle** —
see the keep-alive note at the bottom.

No credit card is required for a free web service.

## 1. Push the repo

Make sure `render.yaml` and the `Dockerfile` are committed and pushed to GitHub.

## 2. Create the service from the blueprint

1. Sign in at <https://render.com> with your GitHub account.
2. **New +** → **Blueprint**.
3. Pick this repository. Render reads `render.yaml` and shows a `teledrive`
   web service.
4. It will prompt for every env var marked `sync: false`. Fill them in (next
   step), then **Apply**.

## 3. Environment variables

Set the same values you already use on Vercel:

| Variable | Value |
|---|---|
| `BOT_TOKEN` | your @BotFather token |
| `DATABASE_URL` | Supabase **transaction pooler** URL (`:6543`, `?pgbouncer=true&connection_limit=1`) |
| `JWT_SECRET` | your existing secret |
| `WEBHOOK_SECRET` | your existing secret |
| `NEXT_PUBLIC_APP_URL` | your Render URL, e.g. `https://teledrive.onrender.com` |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | bot username without `@` |
| `API_ID`, `API_HASH`, `SESSION_ENCRYPTION_KEY` | optional — 2 GB+ uploads |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional — Google sign-in |

`NEXT_PUBLIC_APP_URL` is baked into the build, so if you rename the service you
must set it and redeploy.

## 4. First deploy — one-time wiring

The database schema and the Telegram webhook live outside the container, so do
these once after the first successful deploy:

1. **Apply the schema** (adds any new tables). From your own machine, with the
   production `DATABASE_URL` in `.env.local`:
   ```bash
   pnpm db:sync
   ```
2. **Point the bot webhook at Render** (only if you want the bot driven from
   this deployment — don't run it from two hosts on the same token at once):
   `https://<your-service>.onrender.com/api/bot/setup?key=<WEBHOOK_SECRET>`
3. **Register the domain with BotFather** for the one-tap login widget:
   `/setdomain` → your bot → `https://<your-service>.onrender.com`

## 5. AI features (optional, off by default)

`render.yaml` sets both flags to `"0"`, so the AI platform ships dark: every
`/api/ai/*` route answers 404 and the **AI keys** card in Settings hides itself.

| Variable | Set to | Effect |
|---|---|---|
| `AI_ENABLED` | `1` | Turns on the BYO-key vault, router and `/api/ai/*` routes. |
| `JOB_WORKER_ENABLED` | `1` | Drains the background job queue **in this container**. |
| `SESSION_ENCRYPTION_KEY` | required | Without it the vault refuses to store keys rather than saving them unencrypted. |

Two things worth knowing:

- Changing these needs only a **restart, not a rebuild**. The Settings card asks
  the server whether the feature exists instead of reading a `NEXT_PUBLIC_*`
  value, and `NEXT_PUBLIC_*` is the only thing baked into the browser bundle.
- Only turn on `JOB_WORKER_ENABLED` here, never on a serverless deployment: the
  worker is a loop that outlives a request, and a serverless function is killed
  long before a job finishes. Note that a sleeping free service is not draining
  the queue either — see the keep-alive note below.

## 6. Keep it awake (optional but recommended)

A free service sleeps after ~15 minutes idle; the next visit then waits ~30–60 s
for a cold start, which can interrupt an in-flight upload. Ping it every ~10
minutes to keep it warm. Any of:

- A free scheduler like <https://cron-job.org> hitting `https://<service>.onrender.com/`.
- Render's own free Cron Job service pinging the URL.

You already need a similar keep-alive for the Supabase free database (it pauses
after ~1 week idle), so one ping covers both.

## Running the bot from only one place

If TeleDrive is also live on Vercel with the **same** `BOT_TOKEN`, only one
deployment should own the webhook — whichever you point `/api/bot/setup` at last
wins. Set the webhook to the host you want to keep, and treat the other as a
cold standby.
