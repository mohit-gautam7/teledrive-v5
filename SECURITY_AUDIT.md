# Security audit — 19 September 2026

Scope: the whole repository at `15356ee`, its dependency tree, and the Supabase
project `ucuyzmrbbyxtnmjkoclu` that holds production data. Fixes landed on
`rescue/security-and-upgrade`; the pre-audit state is tagged `pre-rescue-2026-09-19`.

Everything below was verified against the code or the database, not inferred
from the shape of the project. Where something could not be verified — because
the database was paused throughout the audit — it says so rather than guessing.

---

## Critical

### C1 — Next.js 14.2.35: two unauthenticated remote code executions — FIXED

`next@14.2.35` carried 26 advisories. Two are critical and need no session:

- **Unauthenticated RCE on Windows-hosted servers** (patched `>=15.5.24`)
- **Unauthenticated RCE in the Image Optimization API when an AVIF is served**
  (patched `>=15.5.24`)

There is no backport to the 14 line, so the fix is the major upgrade. Done in
`cc2f747`: Next 15.5.25, React 19, the official async-request-api codemod, plus
three corrections the codemod cannot make (`NextRequest.ip` is gone; the
`UnsafeUnwrapped*` casts it leaves behind are a deprecated shim;
`serverComponentsExternalPackages` and `instrumentationHook` left `experimental`).

`tsc --noEmit` clean, production build clean, and the runtime tree now reports
**0 critical and 0 high**.

### C2 — Supabase: every table in `public` readable and writable by anyone — FIX WRITTEN, NOT YET APPLIED

This is the warning the Supabase advisor raised (`rls_disabled_in_public`), and
it is worse than the wording suggests. Supabase exposes `public` through
PostgREST and grants `anon` and `authenticated` full DML on anything created
there. The `anon` key is published in the browser bundle by design. With RLS
off, the exposure was every row of every table — the file index, share tokens,
and the encrypted MTProto sessions in `StorageConfig` — readable, writable and
deletable by anyone who loaded the page.

The fix is `scripts/security-rls.sql`, applied and verified by
`node scripts/security-rls.mjs`:

1. RLS on every table in `public`, found by a catalogue query rather than a
   hand-kept list, so the next table Prisma adds is covered too.
2. No policies, deliberately. A policy only matters to a caller arriving through
   PostgREST, and the right number of those is zero — there is no
   `@supabase/supabase-js` in the dependency tree and no import of it anywhere
   in the source. Supabase is used purely as hosted Postgres, reached by Prisma
   as the table owner, and Postgres exempts a table's owner from its own RLS
   unless `FORCE ROW LEVEL SECURITY` is set. The script does not set it, so
   **the application is unaffected**.
3. The grants revoked as well, including `USAGE ON SCHEMA public` — so a future
   table created without RLS is not instantly exposed the way every table here was.
4. The Supabase default privileges revoked, which is the part that makes the fix
   hold instead of needing re-applying after every migration.

**Status: written and syntax-checked, not yet run.** The project was paused for
the whole audit, so the before/after numbers this script prints do not exist
yet. It must be run — and Supabase's advisor re-checked — once the project is back.

Still to check by hand in the dashboard, because the API was unreachable:
Storage bucket visibility, and whether any Edge Function or database function
runs as `security definer`.

---

## High

### H1 — An unset `WEBHOOK_SECRET` was a login-as-anyone bypass — FIXED

`/api/bot/webhook` guarded its secret-token check with `if (secret)`. With the
variable unset the check was skipped entirely, so the route accepted anything.
That matters because of what is behind it: `handleTelegramUpdate` issues a login
code for whatever `telegramId` the request body claims, and `/api/auth/bot-login`
exchanges that code for a session cookie. A single forged POST was therefore a
login as any user, the owner included.

A missing environment variable should never be the difference between
authenticated and open. Fixed in `f77f5c4`: no secret, no updates, 503, and a
log line saying why.

*The variable is set on the current deployment, so this was latent rather than
live — but it would have become live on any redeploy that missed it, which is
exactly the migration this work is doing.*

### H2 — Login codes came from `Math.random()` — FIXED

`sixDigitCode()` in `lib/bot-handler.ts` used `Math.random()`. These codes are
bearer credentials — whoever presents one becomes the account it was issued for
— and V8's generator state is recoverable from a handful of outputs. Anyone who
could make the bot issue a few codes could predict the codes issued to others.
Now `crypto.randomInt`.

### H3 — The six-digit code had no effective brute-force bound — FIXED

`/api/auth/bot-login` looks a code up by the code alone: any outstanding code
from any user is a winning guess. The only limit was a per-IP bucket, and since
Next 15 removed `NextRequest.ip` that address comes from a caller-controlled
header — rotate it, get a fresh allowance. Added a second bucket keyed on the
route rather than the caller, counted only on a wrong code so that one attacker
cannot lock everyone else out by spending the budget.

### H4 — `/api/bot/setup` was an oracle for `WEBHOOK_SECRET` — FIXED

Compared the key with `!==` (not constant-time), took it only from the query
string (access logs, browser history, `Referer`), and had no rate limit. Now a
timing-safe compare, limited per-caller and globally, and it prefers an
`x-webhook-secret` header. The query parameter still works, because the docs
tell people to visit a URL.

---

## Moderate

### M1 — Rate-limit keys trust a caller-controlled header — ACCEPTED, DOCUMENTED

`clientIp()` reads `x-real-ip` then the leftmost `x-forwarded-for`. Behind
Vercel or Render both are set by the platform; reached directly, both are
forgeable. Forging one buys a fresh rate-limit bucket and nothing else — no
value from these headers reaches an authorisation decision. The one place where
that bound genuinely mattered now has a second, un-forgeable bucket (H3). The
caveat is written where the helper is defined rather than at seven call sites.

### M2 — Four `postcss` advisories in a copy Next vendors — ACCEPTED

`next` depends on `postcss@8.4.31`, which carries four `sourceMappingURL`
path-traversal advisories. They require processing attacker-supplied CSS; only
first-party CSS is ever processed here, and only at build time, never in the
running server. A `pnpm` override to the patched line did not take effect
against the vendored copy and pursuing it risked the build for no real gain.
Revisit when Next bumps it.

### M3 — `effect` and `deepmerge-ts` advisories under `@prisma/config` — ACCEPTED

Both are stack-exhaustion DoS reachable only through config parsing, and
`@prisma/config` is used by the Prisma **CLI** at build time — it is not in the
runtime client. No untrusted input reaches either. Prisma's current release is
`8.0.0-rc`, and moving a working data layer onto a release candidate during a
rescue is the wrong trade.

### M4 — `script-src` still needs `'unsafe-inline'` — PRE-EXISTING, DOCUMENTED

Next inlines its hydration bootstrap and `app/layout.tsx` inlines the pre-paint
theme script. Nonces would fix both but need per-request middleware on every
route. The directives that actually contain an XSS are tight — `object-src
'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, and
`connect-src 'self'`, which leaves injected script nowhere to send what it
reads. File bytes are served under their own `default-src 'none'; sandbox`.
Noted because it is the weakest line in an otherwise strong policy, not because
it is new.

---

## Audited and found sound

Not everything looked at was broken. Recorded so the next audit need not re-derive it:

- **Access control.** Every file, folder, share and bulk route scopes its query
  by `userId`. Bulk actions are bounded at 500 ids. The bulk-move destination
  goes through `resolveOwnedFolder`. No IDOR found.
- **The split-origin credential design.** The session cookie never reaches the
  file origin; a separate file-scoped JWT does, and `lib/auth.ts` refuses a
  file token presented as a session and a session token presented as a bearer.
  So the token that ends up in a `?t=` URL buys an hour of access to bytes, not
  an account. CORS carries no `Allow-Credentials`, so the wildcard-versus-
  credentials trap cannot arise.
- **Secrets in git.** None. Searched the full history for the live `BOT_TOKEN`,
  `API_HASH`, `JWT_SECRET`, `WEBHOOK_SECRET` and `SESSION_ENCRYPTION_KEY`
  values, for token-shaped strings, and for any `.env*` file ever committed.
  All clean; `.gitignore` covers every env file in use.
- **Security headers.** HSTS, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, and a `Permissions-Policy` that denies everything the app
  does not use.
- **Upload retry.** Full-jitter exponential backoff, fail-fast on 4xx other than
  429, and — since `1407e80` — it honours a server-named `Retry-After`, which is
  how Telegram's `FLOOD_WAIT` arrives.
- **Stored secrets.** MTProto sessions are AES-256-GCM encrypted at rest
  (`lib/crypto.ts`) and the AI key rows never select the ciphertext into
  anything client-bound.

---

## Not yet done

- **Apply C2.** Blocked on the Supabase project being restored.
- **Rotate credentials.** Nothing leaked, so this is hygiene rather than
  incident response — but `BOT_TOKEN`, `JWT_SECRET`, `WEBHOOK_SECRET` and
  `SESSION_ENCRYPTION_KEY` have all sat in a local `.env.vercel` written for
  bulk-pasting into a dashboard. Rotating `JWT_SECRET` signs everyone out;
  rotating `SESSION_ENCRYPTION_KEY` **invalidates stored MTProto sessions** and
  every linked account must re-authorise. Decide deliberately, not by reflex.
- **CodeQL and Dependabot.** Both want the GitHub CLI authenticated.
- **Live verification.** Every fix above is verified by type check, build and
  the unit checks in `scripts/`. None has been exercised against a running
  deployment, because there is not one yet.
