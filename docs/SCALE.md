# Concurrency, limits, and what actually breaks first

Honest numbers for "how many people can use this at once", and what each
bottleneck does when it is hit.

## The four constraints

### 1. Telegram Bot API — ~30 messages/second, per bot

This is the hard ceiling on **bot-backed uploads**, and it is shared by every
user of the deployment because there is one bot.

Every 4 MB chunk is one `sendDocument`. So:

```
30 msg/s × 4 MB = ~120 MB/s of aggregate upload, bot-wide
```

In practice Telegram starts returning `429 Too Many Requests` well before that
under bursty load. What the app does about it:

- `lib/telegram-bot.ts` retries up to 6 times with **full-jitter** exponential
  backoff, honouring `retry_after` exactly when Telegram supplies it. Jitter
  matters: without it every uploader retries on the same beat and re-creates the
  burst that caused the 429.
- A process-wide gate caps in-flight `sendDocument` calls at 4. Excess calls
  queue instead of piling into the rate limiter.
- The client uploads at most **3 chunks concurrently per file**
  (`CHUNK_CONCURRENCY`), so one browser cannot monopolise the bot.

**Realistic ceiling: 8–12 people uploading large files simultaneously** before
individual chunks start taking visible retry detours. It degrades — uploads slow
down and resume — rather than failing.

To go beyond that you need more bots. The storage model already supports it:
`StorageConfig.botToken` is per-user, so heavy users can bring their own bot and
get their own 30 msg/s budget.

### 2. Database connections

Supabase's free tier allows a small number of Postgres connections. Serverless
makes this dangerous: each concurrent invocation is an isolated client.

The deployed configuration uses the **transaction pooler** (port 6543) with
`connection_limit=1`, so one request holds one connection for the duration of a
statement and no more. That is what keeps a traffic spike from exhausting the
pool. **Keep this on serverless.** On an always-on VM a single process pools
properly and the limit can be raised — see `docs/DEPLOY.md`.

Also relevant: `/api/files/stats` runs five aggregates and used to run on every
page load. It is now split — the sidebar total is one cheap query, and the full
breakdown only runs when the Insights panel is opened (`?full=1`).

### 3. Serverless concurrency and duration

On Vercel Hobby a function has 1 GB of memory, 60 s of wall clock, and no
long-lived connections.

- **Downloads never buffer.** `lib/file-stream.ts` pulls one chunk at a time and
  enqueues it as the client consumes it, so a 2 GB file uses a few MB of memory,
  not 2 GB.
- **Uploads are bounded by design.** The 4 MB chunk size is what keeps each
  request under Vercel's 4.5 MB body limit.
- **Duration is the real risk.** A slow client downloading a large file can
  exceed 60 s and get cut off. This is a platform limit, not a code one, and it
  is the main argument for moving off Hobby.

### 4. Bandwidth

Every byte is proxied — Telegram file URLs embed the bot token and must never
reach a browser. On Vercel Hobby that is 100 GB/month, and it is almost always
the first limit reached. See `docs/DEPLOY.md`.

## Why an upload no longer fails as a unit

Uploads are **resumable**. `POST /api/upload/init` is keyed on a client-supplied
`resumeKey` (name + size + mtime + destination):

- An interrupted upload for the same file returns the *same* session plus the
  list of chunk indexes already stored, and the client uploads only what is
  missing.
- Chunk writes are **idempotent** — re-sending a chunk that already landed is
  acknowledged without storing a second copy in Telegram.
- A failed chunk retries on its own (5 attempts, jittered backoff) without
  restarting the file.

So a dropped connection costs the in-flight chunks, not the 2 GB behind them.

## File size

| | Limit | Why |
| --- | --- | --- |
| Minimum | 1 byte | Empty files are skipped client-side. |
| Maximum (bot storage) | 2 GB | Telegram's per-file cap. |
| Maximum (linked account, Premium) | 4 GB | Telegram Premium's cap. |
| Upload chunk | 4 MB | Under Vercel's 4.5 MB body limit. |
| Bot download cap | 20 MB per object | Why bot storage must chunk at all. |

There is no route past 4 GB. It is Telegram's number, not ours.

## Two storage backends

| | Bot chat (default) | Linked account (MTProto) |
| --- | --- | --- |
| Setup | none | authorise once, QR or phone code |
| Layout | one message per 4 MB chunk | one message, whole file |
| Max size | 2 GB | 2 GB, or 4 GB with Premium |
| Rate limit | shared bot budget | the user's own account |
| Used for | everything by default | files ≥ 64 MB once linked |

`File.backend` records which one holds each file, and downloads route
accordingly, so both coexist and older files keep working.

## Should this run on several platforms at once?

Short answer: **no — one always-on origin behind Cloudflare, and add *bots*
rather than *hosts* when it saturates.**

The idea is to spread load across Vercel + Oracle + others simultaneously. It is
worth taking seriously, and it does not survive contact with where the limit
actually is.

### The bottleneck is not compute

Every constraint above except bandwidth is a **Telegram** constraint. One bot
token gets ~30 messages/second no matter how many machines are calling it — the
budget lives on Telegram's side, keyed to the token, not to the caller. So:

> Adding a second origin adds **zero** Telegram throughput. Two hosts sharing one
> bot token hit the same 429s at the same aggregate rate, just from two IPs.

That single fact removes most of the appeal. The thing you would be scaling
(compute) is not the thing that is scarce (Telegram's per-token budget). A 2 OCPU
ARM box is nowhere near saturated when the bot starts rate-limiting — the app is
I/O-bound, streaming a few MB at a time.

### And it breaks things that currently work

| | What multi-origin costs |
| --- | --- |
| **Telegram webhook** | A bot can register exactly **one** webhook URL. Two origins means one of them never receives bot updates, so login codes only work on whichever host won. This alone is close to disqualifying. |
| **MTProto sessions** | Warm connections are per-process. Two origins double the handshakes and double the risk of Telegram flagging concurrent session use from different IPs. |
| **Resumable uploads** | Chunk state lives in Postgres, so it technically survives — but a resumed upload landing on a different origin loses any in-process warm client and re-handshakes. |
| **Rate-limit guards** | The in-process cap on in-flight `sendDocument` calls is per-process. Split across N origins it silently becomes N× more permissive, which *causes* the 429s it exists to prevent. Fixing that needs shared state (Redis), i.e. another service to run. |
| **Debugging** | Every "why did this upload fail" question starts with "which origin served it". |

### What actually adds headroom, in order

1. **Cloudflare in front of one origin** — removes the bandwidth ceiling, which
   is the only limit multi-origin would genuinely have helped with. Free.
2. **More bot tokens.** `StorageConfig.botToken` is already per-user, so a heavy
   user brings their own bot and their own 30 msg/s. This is the real horizontal
   scale axis, and it scales the resource that is actually scarce.
3. **Linked accounts (MTProto).** Uploads move onto the user's own Telegram
   account and off the shared bot budget entirely.
4. **A bigger box.** Only after CPU or NIC is measurably the limit.

Multiple origins are step 5 at the earliest, and only for **geographic latency**
— not for throughput.

### When to revisit

Shard to a second origin only when all three are true, measured rather than
assumed:

- Sustained CPU on the VM > 70% at peak, **and**
- Telegram 429 rate near zero (i.e. compute really is the binding constraint), **and**
- Cloudflare cache hit ratio already high, so the traffic is genuinely dynamic.

Until then a second origin adds failure modes and no capacity.
