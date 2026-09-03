# scripts

## check-upload-routing.mjs

Pure assertions over `lib/upload-config.ts` — where an upload is stored, at every
boundary that matters. No server, no database.

```
node scripts/check-upload-routing.mjs
```

## The probes

Four live probes against a **running production build**. They exist because the
things worth checking here — a 20 MB threshold, a share that unlocks, a mime type
that must not render — are properties of a real HTTP response and a real Telegram
round trip, not of a function in isolation.

All four clean up after themselves: every row and every Telegram message they
create is deleted before they exit, and the two that mutate an existing row put
it back in a `finally`. Run them against your own account.

```
# 1. Build and serve
pnpm build
node -r dotenv/config .next/standalone/server.js

# 2. Shared environment
export DOTENV_CONFIG_PATH=.env.local
export PROBE_BASE=http://localhost:3000       # optional, this is the default
```

### probe-security.mjs — 38 checks

Anonymous refusal, unknown-id responses, the folder-ownership guards, inline
rendering, the whole share lifecycle (locked, wrong password, unlocked, replayed
at another share, disabled, expired, revoked), rate limits, error-body leakage,
and SSRF on an AI key's base URL.

Needs `OWNER_LOGIN_KEY` set to the same value the server was started with.

```
OWNER_LOGIN_KEY=… node scripts/probe-security.mjs
```

### probe-xss.mjs — the one that matters most

Flips one file's stored mime type through `text/html`, `image/svg+xml`,
`application/xhtml+xml` and `text/xml`, confirms none of them is served for the
browser to render, and restores the original type in a `finally`. The control at
the end checks a real image still renders inline, so a fix that simply refused
everything would fail.

```
OWNER_LOGIN_KEY=… node scripts/probe-xss.mjs
```

### probe-bigfile.mjs — P1 end to end

On a **linked** account: a file above the bot's download ceiling must go through
MTProto as one message in Saved Messages, and must come back byte-identical,
including a ranged read. `--routing-only` proves the routing decision without
sending a byte.

Signs in by minting the same JWT the app's login mints, rather than through
owner-login, which would write `name: "Owner"` onto the account it signs in as.

```
PROBE_TELEGRAM_ID=<a linked account's telegram id> node scripts/probe-bigfile.mjs --routing-only
PROBE_TELEGRAM_ID=<…> PROBE_SIZE_MB=22 node scripts/probe-bigfile.mjs
```

### probe-flows.mjs — the regression net

Upload, download, folders, move, bulk move, favourite, rename, share, zip, trash,
restore, copy-by-reference, and the batched page load. Run it after anything that
touches a route.

```
PROBE_TELEGRAM_ID=<any account's telegram id> node scripts/probe-flows.mjs
```
