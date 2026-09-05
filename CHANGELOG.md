# Changelog

The version in `package.json` is the single source; `next.config.mjs` bakes it
into the bundle and **Settings → About** shows it next to the build time. After a
deploy, that is where you check whether what you pushed is what is live.

Bump it in the same commit as the change: patch for a fix, minor for a feature.

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
