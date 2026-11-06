# Bulk upload

What it does, what it does not, and what was actually tested rather than
assumed. Everything below was exercised on 19 September 2026 against a restored
copy of the production database and the real Telegram channel.

## Selecting

| | How |
|---|---|
| Files | **Upload → Upload files**, or drop them anywhere on the page |
| A folder | **Upload → Upload folder**, or drop the folder itself |
| Nested folders | Both routes walk the tree recursively |

A dropped directory is walked through `webkitGetAsEntry`; the folder picker uses
a `webkitdirectory` input. The difference matters for resuming rather than for
selecting — see below.

**Folder structure is preserved.** `MyData/Movies/trip.mp4` recreates
`MyData` → `Movies` and puts the file inside, relative to wherever you dropped
it. Verified: a three-level tree (`BulkTest/nested/deeper`) arrived as exactly
three nested folders with one file each.

## The queue

Lives in a module, not in a React component, so it keeps running while you move
around the app — opening Settings or a share page does not abort an upload.

Shows, at the top: how many are done, how many failed, how many are paused,
total bytes moved against total bytes queued, current speed and ETA. Speed comes
from a rolling window of byte deltas, not a whole-transfer average, so it
reflects the connection you have now.

Per file: name, percentage, bytes, speed, ETA, and any error in full.

**Batch controls:** Pause all, Resume all, Cancel all. Resume all also restarts
everything that *failed*, so it doubles as retry-all-failed. Completed rows
clear themselves after a moment; skipped duplicates stay, because "12 files were
already here" is the answer to what just happened.

**Per file:** pause, resume, retry, cancel, dismiss.

Measured: 200 files entered the queue in 38 ms, and the aggregate counters and
folder chain were correct throughout.

## Concurrency

**Settings → Upload storage → Files at once**: 1, 2, 4 or 8. Default 2.

Read fresh on every scheduling pass, so changing it steers a queue that is
already running — lower it and the extra workers drain and stop; raise it and
more start at the next completion. Neither disturbs a file already sending.

It **multiplies** with `UPLOAD_CONCURRENCY` (3 by default), which is the
parallelism *within* one file. Two files at once is already six requests in
flight against a bot budget of roughly 30 messages a second.

Higher is not simply better, and the setting says so. Telegram answers a flood
by lengthening the next wait, so 8 can finish a large queue *slower* than 2. Use
8 for big files on a fast link, where per-file overhead is noise.

## Rate limits and FloodWait

A 429 from a chunk is usually Telegram's `FLOOD_WAIT` relayed through
`lib/api-response`, and it carries the delay Telegram actually asked for.

- If the server names a `Retry-After`, that wins over the client's own backoff.
  Retrying on a guess means retrying into the same flood, which Telegram
  punishes by extending it.
- Both legal header forms are handled (delta-seconds and HTTP-date). A stale
  date clamps to "now", never to "no limit".
- **Above 90 seconds it deliberately does not wait.** A long `FLOOD_WAIT` is
  measured in hours; sleeping through one holds a worker and is
  indistinguishable from a hang. Instead the file fails with the remaining time
  in the message and the queue moves on. Nothing is lost — the chunks already
  stored survive, so Resume continues rather than restarts.
- Everything else uses full-jitter exponential backoff, five attempts, and fails
  fast on any 4xx that is not 429.

Covered by `node scripts/check-backoff.mjs`.

## Resuming

Chunks are confirmed server-side as they land, so a resumed upload continues
from the last confirmed chunk rather than from zero.

**What survives what:**

| | Survives? |
|---|---|
| Navigating within the app | Yes — the upload never stops |
| Page reload / tab close, file **over 4 MB** | Yes — reopens paused, Resume continues |
| Page reload / tab close, file **4 MB or under** | No, and there is nothing to resume: it is sent in one request, so there is no partial state on either side |
| Backend restart | Yes — confirmed chunks are rows in the database |
| Network drop | Yes — retried, then resumable |

Verified: a 60 MB upload paused mid-flight, the page reloaded, and the queue
came back showing `0/1 done · 1 paused · 0 B / 60.0 MB` with Resume offered.

**The one thing a browser genuinely cannot do is outlive its tab.** No worker or
service-worker trick keeps a `File` streaming after the document is gone — the
handle to the bytes dies with it. So a closed tab pauses; it does not continue.
The panel says exactly that rather than implying more.

On resume the app tries to get the bytes back without a file dialog: file and
directory handles are kept in IndexedDB, and a Resume click is a real user
gesture, which is the one moment the browser allows re-requesting permission on
a stored handle. A folder is remembered as one directory handle and individual
files are resolved by walking their relative path — otherwise a 200-file folder
interrupted by a tab close would need re-picking 200 times.

## Duplicates

Before uploading, each file's destination is checked. Matching is on a content
fingerprint; files uploaded before that column existed also match on name and
size.

If anything is already there you get a dialog, per file: **Skip**, **Replace**,
**Keep both** — plus **Skip all / Replace all / Keep both all**, the destination
path of each match, and a running summary of what the current choices will do.

**The default is Skip, and nothing is deleted to make room.** Replace moves the
old file to Trash rather than purging it.

Verified: re-uploading three identical files produced "3 files are already here",
each row showing its correct nested destination, with Skip preselected and
"Nothing will be uploaded · 3 skipped".

## Large files

The ceiling is Telegram's, not TeleDrive's.

| | Limit |
|---|---|
| Bot storage, per chunk | 20 MB (the most a bot can serve *back*) |
| Linked Telegram account | 2 GB per file, 4 GB with Premium |

Anything over 20 MB is stored through your own Telegram account as a single
message when one is linked — **Settings → Your Telegram account**. Without a
linked account, files are chunked and reassembled on download.

A file beyond the ceiling is rejected with a message saying so. It does not fail
silently.

The asymmetry is the trap worth knowing: a bot may *upload* a 50 MB document but
may only *download* 20 MB of one. An early version stored anything under 50 MB
as a single document, and files between those numbers went up fine and can never
come back down. Chunking exists to stay under it.

## Rclone

**Not supported, and not worth faking.** Rclone speaks a fixed set of protocols
— WebDAV, S3, SFTP and its named cloud backends. TeleDrive's API is none of
them: uploads are an `init` / `chunk` / `complete` sequence with its own resume
and duplicate semantics.

The honest options, in order of effort:

1. **A WebDAV layer over the existing API.** The real work is not the verbs, it
   is that WebDAV has no resumable upload, so a dropped connection on a 2 GB
   file restarts it. Everything the queue does well would have to be rebuilt.
2. **An rclone backend** for TeleDrive. Go, out of tree, and it would need
   maintaining against both projects.
3. **Neither.** The browser queue already handles thousands of files, survives
   reloads, and resumes. For a one-off import of a large archive it is slower to
   babysit than rclone, but it is what exists and it works.

If a headless import matters more than the UI, say so and the WebDAV layer is
the place to start.

## Multiple bots and channels

Per user, storage is one bot plus optionally one linked account
(`StorageConfig`). Files record `storageChatId`, so the *schema* already
tolerates several destinations — the production database has three distinct
values — but nothing selects between them for new uploads, and there is no
rollover when a channel fills.

Adding it means a destination table, a selection policy, and care that a file's
chunks never split across destinations. Worth doing only if a single channel
becomes a real limit; it is not one today.
