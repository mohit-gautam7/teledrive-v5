# TeleDrive for Android

## Upload and backup update: 1.2.0

Manual uploads use the shared direct Telegram uploader when Direct upload is enabled.
In Settings, connect this app with a phone code (or QR on another device), then use
**Test connection** before uploading. QR login can be cancelled without reloading.
Keep the app open until the transfer is saved; updated builds keep the screen awake
while a manual upload is active. Pausing or finishing releases that screen flag.

In **Settings > Photo and video backup**, updated Android builds also offer a
**Backup route** choice:

| Route | Where original bytes go | When it runs |
| --- | --- | --- |
| Direct to Telegram | Phone to Telegram; only metadata uses the website | Press **Back up directly now**, keeping the app visible |
| File server | Phone to the configured file server, then Telegram | Scheduled Android background jobs, including when the app is closed |

Direct album backup reads selected MediaStore files in at most 512 KiB pieces;
it never loads a whole video into the WebView. It respects the album, media type,
size, network and charging filters. The phone does not contact Render for this
backup. The website still needs its database and linked Telegram server session
to verify and record the uploaded messages.

Hiding the app pauses direct backup at a part boundary. Start it again to
continue: confirmed files remain saved, while an interrupted file can restart.
An upload that reached Telegram but lost the website confirmation retains its
message receipt, so retrying confirmation does not resend the original bytes.
The direct limit is 2,000 MiB per file (4,000 parts of 512 KiB).

**Re-check selected albums** resets the scan; press **Back up directly now** to
run it. Changing the source, filters or destination also resets the scan.
The backup cursor advances only after the drive confirms the file. Switching
accounts resets that cursor and the old account's destination. Existing Android
backup uses the server's filename/size/folder duplicate policy, including in
direct mode; this is not a byte-for-byte integrity comparison.

Automatic background backup is a separate implementation: it still requires the
configured HTTPS file server and does not implement native background MTProto
uploads. Selecting direct mode cancels relay scheduling; there is no automatic
fallback. An absent file server pauses relay backup without falling back to the
website host. The worker also refuses to complete a truncated local file.

Previews and downloads still use the file server. Use **Connection health** to
check the current network and **Test connection** to check Telegram separately.
These checks do not upload a test file.

Both the website update and a newly built APK are needed for the new native
bridge. The shell loads the deployed website; changing local files alone does
not update the installed app. See [verification notes](../UPLOAD_REVIEW.md)
for exactly what was tested and what still needs device validation.

Run `npm test` and `npm run check` from the project root for the web regression
checks. Android validation still requires the Gradle commands in Building below
and a device test of upload, download, pause/resume, and background backup.

The website, in a native shell, plus the one thing a website cannot do: **back up new
photos and videos while the app is closed.**

```
mobile/
  capacitor.config.json      points the shell at the live site
  android/                   the Android project
    app/src/main/java/app/teledrive/codex/
      MainActivity.kt        registers the plugin, keeps the session cookie alive
      backup/
        BackupPlugin.kt      everything the web page can call
        BackupWorker.kt      the job that runs with the app closed
        BackupScheduler.kt   when it runs, and under what conditions
        MediaScanner.kt      finds photos the backup has not seen
        TeleDriveClient.kt   speaks the existing upload API
        ChunkReader.kt       cuts a file into chunks without truncating it
        BackupPrefs.kt       the watermark and the settings
        BootReceiver.kt      puts the schedule back after a reboot
```

## Why a native app exists at all

The browser version of phone backup can only catch up when you open TeleDrive, because
a web page stops existing the moment it is closed. There is nothing left to notice a new
photo, and nothing left to upload it.

Android has exactly one API that survives the app being swiped away — **WorkManager** —
and it is only reachable from native code. That is the whole reason this directory is here.
Everything else, the entire UI included, is still the website.

## Backup controls in Android 1.2.0

See [Photo and folder backup](../PHOTO_BACKUP.md) for the Wi-Fi/mobile/both/off
choices, source albums, destination folders, waiting/saved/failed lists and counts.
This version never sends background file bytes to Vercel as a fallback.
Install an update with `adb install -r` using the same signing certificate; do not
uninstall the app to update it, because uninstalling erases its local settings.

## Connect Telegram on the same phone

In Settings, switch **Direct upload** on and choose **Sign in on this phone**.
Enter your existing Telegram number with its country code, then enter the code
Telegram delivers and your two-step password if requested. This code comes from
Telegram, not the TeleDrive login bot. No QR scan or second device is needed.
The browser creates its own Telegram session; it does not reuse the server's key.
QR login remains available when you have another device to scan it with.

## How a background relay run works

1. **MediaStore** is asked for photos and videos added after the stored watermark.
   Not a folder scan: a phone with 40,000 photos must not re-list all of them every
   two hours.
2. The server is asked, in one request, which of them it already holds.
3. Each remaining file is uploaded through the same `/api/upload/init` →
   `chunk` → `complete` sequence the website uses, in 4 MB chunks read straight from
   MediaStore so a 4 GB video costs one chunk of memory instead of its own size.
4. The watermark advances **after** each file is stored, never when it is queued, so a
   run that is killed halfway resumes instead of skipping.

A run handles at most 50 files. WorkManager gives a worker about ten minutes, so a first
run on a full camera roll takes several runs — each picking up exactly where the last one
stopped.

## The session

The worker has no credentials of its own. You sign in inside the app's WebView exactly as
you would in a browser, and the worker reads that session cookie through Android's
`CookieManager`, which can see `httpOnly` cookies because it is native code rather than
JavaScript.

The consequence is deliberate: **sign out and backup stops.** There is no second
credential stored anywhere, and nothing to leak if the app is pulled apart.

## The real obstacle is not Android

Stock Android runs this fine. ColorOS, OxygenOS, MIUI, One UI and EMUI each kill
background work in their own way, and an app whose backup silently stopped three weeks ago
is worse than one that never worked, because nobody checks.

So the Settings card asks for two separate things, and says why:

- **Battery optimisation exemption** — the standard Android prompt.
- **Auto-launch / startup manager** — a vendor-specific screen with no API. It cannot be
  read or set programmatically, only opened. `BackupPlugin.startupSettingsIntent()` knows
  the component names for OPPO, OnePlus, Realme, Vivo, Xiaomi, Samsung and Huawei, tries
  each until one resolves, and falls back to the app's own settings page.

## Building

Needs a JDK (21 works) and the Android SDK. No Android Studio required.

```bash
cd mobile
npm install
npx cap sync android

cd android
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest # ChunkReaderTest
```

Install over USB:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug-signed on purpose: it installs without a store account, and every build uses the
same debug key, so later builds update in place instead of forcing an uninstall.

## Watching it work

```bash
adb logcat -s TeleDrive:* WM-WorkerWrapper:* Capacitor:*

# Don't wait two hours for the periodic run:
adb shell cmd jobscheduler run -f app.teledrive.codex <jobId>
```

The `BackupPrefs` values are plain SharedPreferences, so the watermark and the last result
can be read directly:

```bash
adb shell run-as app.teledrive.codex cat shared_prefs/teledrive.backup.xml
```

## What it deliberately does not do

- **Direct backup does not continue with the app closed.** The visible app reuses
  the website's Telegram client. True background direct upload would require a
  native MTProto client and its own persistent session. The existing background
  route still consumes file-server bandwidth.
- **It does not back up anything but the camera by default.** Screenshots, WhatsApp media
  and Telegram's own cache are other people's copies of files, and including them silently
  triples what a user stores. There is a switch for it.
- **It does not watch for photos as they are taken.** WorkManager supports content-URI
  triggers, which would be the nicer behaviour; the periodic job is simpler, survives
  reboots without extra bookkeeping, and bounds the worst case at two hours.
