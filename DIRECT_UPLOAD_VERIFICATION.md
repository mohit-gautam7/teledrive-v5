# Direct upload verification — 11 November 2026

Result: **PASS for the tested manual direct-upload flow**, on the USB-connected Android phone against the live production website.

Website: https://teledrive-codex.vercel.app
Implementation: https://github.com/mohit-gautam7/teledrive-v5/pull/48

## Live checks

| Check | Result |
|---|---|
| Telegram connection in the installed app | Direct upload On; browser connected |
| Small-file upload | 614,417-byte synthetic file stored through MTProto |
| Upload destination | Telegram WebSocket at flora.web.telegram.org |
| Original file relayed through a host | Zero relay attempts; relay requests were blocked during the test |
| Confirmation interruption | Deliberately blocked the first metadata confirmation |
| Retry | Completed; only 153 additional WebSocket bytes, not another file upload |
| Queue display and persistence | Direct badge visible; small-file queue entry persisted |
| Repeated confirmation | HTTP 200; safe repeat accepted |
| Download | Entire synthetic file downloaded directly through Render, HTTP 200 |
| Content integrity | All 614,417 bytes matched the generated source |
| SHA-256 | 5ddefc57f14f7b1156ee8387dfd436eaf9c08e32cb19457b00b9fdd21307f1a6 |
| Signed-out direct-session endpoint | HTTP 401 |
| Signed-out direct-completion endpoint | HTTP 401 |
| Production health | Website, database and Telegram checks passed |

Only small synthetic files were used. No bulk downloads or sweep of existing file contents was performed. Vercel still handled small metadata/authentication requests; original file bytes did not pass through Vercel during the successful direct transfer.

## Local regression checks

Passed: backoff, duplicate detection, 3D motion, upload routing, webhook target guards, direct login/account/status checks, direct-only routing and confirmation receipts, bounded file-part processing and cancellation. TypeScript check passed.

## Limits of this verification

- This does not establish unlimited capacity or guaranteed uptime.
- Huge files, prolonged overnight transfers, browser refresh during a partial transfer, a new OTP login and physical device restart were not tested in this pass.
- Partial direct uploads may restart; a completed Telegram message can be confirmed without resending its bytes.
- Native Android background backup is not a direct MTProto uploader. The older APK can fall back to Vercel if Render is unreachable. Automatic backup was left Off to protect the remaining Vercel allowance.
- Synthetic test files were moved to Trash after verification. Existing user files were not changed.
