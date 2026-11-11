# Photo and folder backup

Open **Settings** in [TeleDrive](https://teledrive-codex.vercel.app).

## Android app: automatic photo/video backup

Android app 1.1.0 adds these controls. Existing sign-in and backup settings are preserved when updating the APK.

1. Under **Automatic backup**, select the source albums. Photos, videos and the size limit can be configured while backup is off.
2. Under **Save backups into**, choose a TeleDrive folder. Nested paths are shown in full. **New destination folder** creates a folder under the selected folder, or at the drive root if no destination exists yet.
3. Choose **Wi-Fi only**, **Mobile data only**, or **Wi-Fi and mobile data**. **No backup — off** stops automatic backup without deleting saved files.
4. Optionally require charging and select a check interval. Android decides the exact time, so a scheduled run can arrive late.
5. **Back up now** starts a run with these same network rules. Only Wi-Fi really means Wi-Fi transport; metered/unmetered classifications are not substituted for connection type. Both permits other online connections too.

Changing source albums or media filters re-checks the selected source, including older files. Existing duplicates are skipped. Changing the destination applies to new runs; **Re-check everything** is the explicit way to copy old source files into a new destination. Selected Android albums are combined in that destination.

### See what is happening

- **Saved so far** is this device's recorded cumulative successful uploads.
- **Waiting** is local media not processed with the current source settings. Some candidates may already be in the destination and will be skipped after the duplicate check. The count refreshes about every ten seconds.
- **Running now** shows the current filename, bytes, batch position, Skip this file and Stop this run.
- **Show backup files and progress → Waiting / remaining** lists pending filenames, 50 per page.
- **Files in destination** lists actual stored files, including subfolders, with the current total. It may include files uploaded from other devices too.
- **Recent activity** retains the latest 200 file results on this device, including failures and their reasons. **Failed files** filters the latest failed results. History starts with this update; earlier saved files are visible in the destination list.
- Use **Refresh list**, **Next 50** and **Previous** to browse without downloading file contents.

Background file bytes go to the configured file server. If it is unavailable, backup waits; it does not fall back to Vercel. Authentication and metadata still use the website. Render/Telegram/network limits still apply. This is separate from browser-direct MTProto upload.

## Website: source-folder backup while the page is open

1. Open **Browser folder backup**. Choose a local **source folder** when the browser requests access.
2. Select the **destination** in your drive, or leave **Browser backup** selected to create it when a backup starts. Folder hierarchy is preserved.
3. Select a network choice and press **Back up now**. Switching to Off pauses queued browser backups. Other manual uploads are unaffected.
4. Follow filenames, progress, pause, resume, retry and cancel in **Transfers**. Backup-specific waiting and activity lists are also available in Settings.

Some browsers cannot distinguish Wi-Fi from mobile data. A network-only choice then pauses safely; Both allows any online connection. If network eligibility changes, queued backup files pause. Resume them from Transfers after reconnecting. The website cannot continue streaming files after its page is closed; use Android automatic backup for that.

Browser source handles, counters, queue state and recent history belong to that browser/account. Existing browser source folders may need to be selected again after this update because their handles are now separated by account. A restored queue may ask you to pick a file again. **Re-check all source files** includes files copied with an old modification date; duplicate checks still apply.

Browser direct upload remains available for manual and browser-folder uploads. When enabled it sends file bytes to Telegram and refuses silent server fallback. It does not make the native Android background worker a direct MTProto uploader, and it does not provide unlimited capacity or guaranteed uptime.
