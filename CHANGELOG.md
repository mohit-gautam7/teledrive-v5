# Changelog

The version in `package.json` is the single source; `next.config.mjs` bakes it
into the bundle and **Settings → About** shows it next to the build time. After a
deploy, that is where you check whether what you pushed is what is live.

Bump it in the same commit as the change: patch for a fix, minor for a feature.

## 1.2.0

**The duplicate prompt actually appears.** It was built in 1.1.0 and then hidden
by its own error handling. The client treated `/api/upload/check` as advisory and
swallowed *every* failure, so a check that could not run at all looked exactly
like a check that found nothing: no dialog, no message, no console line — and
uploads kept working, so nothing looked broken. Three changes, together:

- The client no longer swallows it. A failed check still lets the upload through
  (the server checks again before it writes), but now says why, on screen and in
  the console. A 200 that is missing `duplicates` — an older deployment — is
  treated as a failure rather than as "nothing to ask about".
- A database without the `File.contentHash` column no longer takes the whole
  check down with a 500. It degrades to name-and-size matching, which is what
  every pre-fingerprint file matched on anyway, and says so once. That column
  ships in `scripts/schema.sql`; a deployment where `pnpm db:sync` was never run
  had the code and not the column.
- `GET /api/upload/check` reports the running version, the build time and
  whether that column exists. Open it signed in — it distinguishes "not
  deployed" from "no column" from "working" in one request.

**Hosting split across two free tiers.** The app on Vercel, every byte of every
file on Render, calling Render directly rather than proxying — a proxied byte
still crosses Vercel and still counts against its 100 GB.

- `NEXT_PUBLIC_FILE_ORIGIN` (Vercel) and `CORS_ALLOWED_ORIGINS` (Render) turn it
  on. Set neither and the app is single-origin exactly as before, which is what
  `pnpm dev` wants.
- `/api/auth/file-token` mints an hour-long, file-scoped JWT, because the
  `SameSite=Lax` session cookie cannot reach the second origin and script cannot
  read it to forward it. Sent as a bearer by `fetch`, and as `?t=` by `<img>`,
  `<video>` and download links, which cannot set a header.
- `lib/auth` refuses a file token used as a session and a session token used as
  a bearer, so the credential that ends up in a URL is not a login.
- `middleware.ts` answers preflights and sets CORS on the file origin. No
  `Allow-Credentials`, because no cookie ever goes there.
- The CSP grows `connect-src` and `media-src` entries for the file origin —
  without them every chunk and every stream is blocked, and blocked silently.
- `/api/upload/check` deliberately stays on the primary origin, so the duplicate
  prompt is not held behind a Render cold start.
- Public share links (`/api/public/stream`, `/api/public/download`) go to the
  file origin too. They authenticate by the token in the path, so they need no
  credential of their own — and a shared video is the single largest thing a
  stranger can pull through the app.

Checks: `node scripts/check-dedupe.mjs` (pure), `GET /api/upload/check` (live).

## 1.1.0

**Resume actually resumes.** The destination folder was being resolved inside the
upload worker on every run, which nested a dropped tree inside itself and — because
the resume key embedded the folder id — changed the key underneath the resume.
`/api/upload/init` then found no session, created a new row, and abandoned every
chunk already on Telegram. Folder uploads never resumed; they silently restarted
from zero. Folder paths are now resolved once, before anything is queued, and the
resume key is keyed on the file alone (`init` already filters by folder and size).

- Directory handles are stored and walked, so a folder upload interrupted by a
  tab close resumes instead of asking for all its files back one at a time.
- Drops onto a folder card remember their handles; only window drops did before.
- Resume re-requests permission on a stored handle before falling back to a file
  dialog — that code path existed and was never reached.
- MTProto sessions older than `MTPROTO_PART_TTL_MINUTES` (default 2 h) hand back
  no chunks rather than finalising a file Telegram has half-expired, and a failed
  finalise clears the chunk ledger so a retry is a real retry.

**Re-uploading a file asks first.** Skip / Replace / Keep both, once for the whole
batch with a per-file override, instead of a prompt per file.

- Content fingerprint (`lib/file-identity.ts`): SHA-256 over the size and up to
  three 1 MiB windows. Full content under 3 MiB, constant time above it, no new
  dependency.
- New `File.contentHash` column and `/api/upload/check`, asked once per batch.
- Both upload paths refuse an unapproved duplicate with 409, so Skip holds even
  when two tabs are told "nothing stored" at the same moment.
- Files that predate the column match on name and size, so an existing library
  does not offer to re-upload itself.
- The same file dragged in twice in one drop collapses to one.
- Replace uploads the new copy first and only then moves the old one to Trash.

**Uploads no longer stutter in the background.** `persist()` was doing a synchronous
`localStorage` write and a full re-render on every progress tick; it is now
coalesced to one paint per frame with a 2 s trailing write, flushed on hide and
unload. A hidden tab now costs nothing to render at all.

**Several folders at once.** Dropping many folders always worked; the Upload
buttons were disabled while anything was uploading, which is what stopped a second
folder being queued. Where the browser has `showDirectoryPicker`, a picked folder
now keeps a handle and can resume like a dropped one.

Checks: `node scripts/check-dedupe.mjs` (pure) and `node scripts/probe-dedupe.mjs`
(live, sends nothing to Telegram).

## 1.0.0

First tracked version — everything before the changelog existed.
