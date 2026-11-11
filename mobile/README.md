# TeleDrive for Android

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

## Backup controls in Android 1.1.0

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

## How a run works

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

- **It does not upload straight to Telegram.** Files go through TeleDrive's server, the
  same route the website's relay path uses, which means they count against the host's
  bandwidth. Direct upload needs an MTProto client, and the only mature one for Android is
  TDLib — a large native dependency for a second implementation of something the browser
  already does. Worth revisiting; not worth bundling blind.
- **It does not back up anything but the camera by default.** Screenshots, WhatsApp media
  and Telegram's own cache are other people's copies of files, and including them silently
  triples what a user stores. There is a switch for it.
- **It does not watch for photos as they are taken.** WorkManager supports content-URI
  triggers, which would be the nicer behaviour; the periodic job is simpler, survives
  reboots without extra bookkeeping, and bounds the worst case at two hours.
