# TeleDrive upload and Android review

Review date: 2026-11-11. Changes are in the working tree. This review did not
deploy the website, build a new APK, or install an update on the connected phone.

## Implemented

- Direct upload confirmation now uses the primary website origin instead of the
  file origin. A client unable to reach Render can still confirm a direct upload
  through Vercel. Original file bytes remain phone/browser to Telegram.
- Relay uploads preserve confirmed chunks after a failed request. Permanent
  client errors fail promptly; temporary failures retry with backoff. Long rate
  limits are surfaced, and cancellation interrupts retry waits.
- Uploads are only marked successful after a complete metadata confirmation.
- Telegram linking supports cancellation, checks that sessions are actually
  saved, separates cached clients by account, and clears revoked connections.
  Settings offers a connection test and a switch from QR to phone-number login.
- Android direct album backup uses native MediaStore reads of at most 512 KiB,
  the existing browser Telegram client, progress, pause, and retry. It respects
  selected albums, media filters, network choice and charging preference.
- Direct backup verifies the signed-in database identity on both sides of the
  native bridge, shares the backup lock with WorkManager, and advances its cursor
  only after a server-confirmed file. Changing accounts or the destination resets
  scan progress. A different account cannot inherit the old destination.
- Direct mode cancels relay scheduling. Background relay remains an explicit
  alternative. A truncated native relay read cannot finalize successfully.
- Manual and direct album uploads have independent screen-awake claims.
- Settings includes website/file-server reachability tests and a separate
  Telegram test. The probe endpoint contains no account or database information.
- The drive overview adds real file/storage/queue statistics, quick actions,
  stronger muted-text contrast, and a lightweight CSS 3D illustration. It uses
  existing local fonts and respects reduced-motion preferences.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 13/13 regression scripts passed |
| `npm run check` | TypeScript passed |
| Next production build | Compiled and generated all 30 static pages; final standalone packaging failed with Windows `EPERM` |
| Android Kotlin source compilation | 16 production/test sources compiled with locally cached dependencies |
| Android JVM tests | 13 tests passed using JUnit and cached dependencies |
| Gradle APK build | Blocked by the session's local daemon connection restrictions |
| ADB / physical phone checks | Blocked by the session's ADB connection restrictions |
| Local browser visual check | Preview could not reach the local server; no visual/device verification claimed |
| `git diff --check` | Passed |

Web regression tests exercise real upload/routing/part-reading code with mocked
Telegram, HTTP and native bridge boundaries. Coverage includes direct-only
failures without relay, metadata-only confirmation routing, confirmation retry,
part boundaries and cancellation, truncated reads, relay recovery, account
binding, ordered acknowledgements, hidden-app pause, and native cleanup failure.
Android tests exercise chunk reads, cursor ordering, network policy, account
changes and lock ownership. They do not replace a device or live Telegram test.

## Device and deployment acceptance checks still required

1. Deploy the web changes and build Android with JDK 21 and the configured SDK:
   `cd mobile/android` then `gradlew.bat :app:assembleDebug :app:testDebugUnitTest`.
   Install the new APK with `adb install -r` and the existing signing key.
2. In the app, enable Direct upload, sign in to the linked Telegram account and
   run Test connection. Test a small document, a photo, and a multi-part video.
   Download them and compare SHA-256 hashes with the originals.
3. Select a small album and destination, choose Direct to Telegram, enable backup
   and press Back up directly now. Check confirmed counts and actual stored files.
4. Pause during a video, background the app, interrupt Wi-Fi, and resume. The
   cursor must not advance for an unconfirmed file; confirmed items must remain
   saved. Direct transfer may restart an interrupted file's parts.
5. With Render unavailable from the device, repeat a direct upload and direct
   album backup. The original bytes and confirmation must succeed independently
   of client-to-Render access. Previews/downloads can still fail until the file
   server is reachable. Manual upload thumbnails are optional small relay calls.
6. Select each network mode and charging-only option and verify it on the phone.
   Switch backup off mid-run; no new parts should be read after the current part.
7. Choose File server explicitly and test a background run, interruption,
   recovery and same-second media ordering. Direct mode must never trigger relay.
8. Test mobile/desktop widths, light/dark themes, keyboard controls, and both
   reduced-motion preferences before treating the visual work as signed off.

## Limits and follow-up architecture

Direct album backup requires the app to remain visible. True direct backup while
the app is closed is not implemented; it needs a native Telegram client and an
independently authorized session. Direct originals bypass the hosting relay,
but metadata, optional thumbnails, previews and downloads still consume some
hosting resources. This is not zero-bandwidth or unlimited storage hosting.

Native duplicate matching currently uses filename, size and destination, not a
full content hash. Two different files with the same name and byte length can
be treated as duplicates. Add native content fingerprints before depending on
it for archives where such collisions are plausible.

The deployment currently shares one server-side Telegram session between hosts.
The source already handles `AUTH_KEY_DUPLICATED` as a revoked session; concurrent
Vercel/Render use should be tested in staging. Independent server credentials or
a single Telegram gateway would make the multi-host architecture more robust.
No credentials or database schema were changed in this review.

## College Wi-Fi and free addresses

The app is configured for https://teledrive-codex.vercel.app. Keep that address
for the website if Vercel works on the college network. Direct upload still
requires that network to allow Telegram's WebSocket endpoints.

[FreeDNS](https://freedns.afraid.org/signup/features/) offers free subdomains
and supports CNAME records. A chosen hostname could be attached to the Render
service using [Render's custom-domain setup](https://render.com/docs/custom-domains),
then used as `NEXT_PUBLIC_FILE_ORIGIN` after HTTPS verification and a rebuild.
Availability and registration were not performed. A new hostname may help with
hostname filtering; it will not fix an IP/provider-level block, an outage, or
Render's bandwidth limits. The new Connection health controls help distinguish
website and file-server reachability on the actual device.

Visual references reviewed: [Awwwards 3D sites](https://www.awwwards.com/websites/3d/)
and [Lusion](https://lusion.co/). The implementation is an original, small CSS
illustration; it does not load those sites' assets or a WebGL engine.
