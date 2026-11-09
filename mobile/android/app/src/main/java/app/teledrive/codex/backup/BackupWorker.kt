package app.teledrive.codex.backup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.util.Log
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * The part a web page cannot do: upload the camera roll while nothing is open.
 *
 * WorkManager keeps the schedule in its own database, reinstates it after a
 * reboot, and is the only API on Android that survives the app being swiped
 * away. Everything else here is in service of three things that go wrong with
 * naive backup code:
 *
 *   1. **Being killed mid-run.** Items are processed oldest-first and the
 *      watermark is raised only after each file is stored, so a run that dies
 *      halfway resumes exactly where it stopped instead of skipping the rest.
 *   2. **Retrying forever.** A file the server refuses outright — too large,
 *      already there, deleted while queued — is counted and stepped over. Only
 *      genuine transient failures end the run in Result.retry().
 *   3. **Being invisible.** A long upload without a visible notification is
 *      what vendor battery managers kill first, so the work promotes itself to
 *      the foreground before it starts moving bytes.
 */
class BackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val prefs = BackupPrefs(context)
    private val scanner = MediaScanner(context)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (!prefs.enabled) return@withContext Result.success()

        // Another run already has it. Stepping aside rather than retrying: the
        // run that holds the lock is doing this work, so there is nothing left
        // undone for WorkManager to back off and repeat.
        if (prefs.anotherRunIsActive()) {
            Log.i(TAG, "another run is active, standing down")
            return@withContext Result.success()
        }
        prefs.holdLock()

        val client = TeleDriveClient(applicationContext, BASE_URL)

        try {
            client.whoAmI()
        } catch (signedOut: NotSignedInException) {
            // Not a failure to retry: no amount of waiting signs a user in.
            // The schedule stays, so backup resumes by itself once they do.
            prefs.releaseLock()
            finish("Signed out — open TeleDrive and sign in.")
            return@withContext Result.success()
        } catch (offline: IOException) {
            prefs.releaseLock()
            return@withContext Result.retry()
        }

        val pending = scanner.scan(prefs, BATCH_LIMIT)
        if (pending.isEmpty()) {
            prefs.clearCurrent()
            prefs.releaseLock()
            finish("Up to date.")
            return@withContext Result.success()
        }

        // Resolve the destination before a single byte moves, and resolve it
        // every run. Uploading with no folder scatters a camera roll across the
        // drive root, and uploading into a folder the user has deleted makes
        // the server answer 404 — which counts as permanent, so every photo
        // would be skipped and the watermark would march past the lot of them.
        val folderId = try {
            client.ensureBackupFolder(prefs.folderId).also {
                prefs.folderId = it.id
                prefs.folderName = it.name
            }.id
        } catch (signedOut: NotSignedInException) {
            prefs.releaseLock()
            finish("Signed out — open TeleDrive and sign in.")
            return@withContext Result.success()
        } catch (error: Throwable) {
            Log.w(TAG, "could not resolve the backup folder", error)
            prefs.releaseLock()
            return@withContext Result.retry()
        }

        setForegroundSafely(0, pending.size)

        val already = runCatching { client.findExisting(pending, folderId) }.getOrDefault(emptySet())
        var stored = 0
        var skipped = 0
        var transientFailure = false
        var transientReason: String? = null
        var stopped = false

        for ((index, item) in pending.withIndex()) {
            if (isStopped) break
            // Also checked here, not only between chunks: a stop asked for
            // while the worker is between files would otherwise be ignored
            // until the next chunk of the next file.
            if (prefs.takeControl() == BackupPrefs.CONTROL_STOP) {
                stopped = true
                break
            }
            setForegroundSafely(index, pending.size, item.name)

            if (already.contains(index)) {
                // Already in the drive: step over it and let the watermark pass,
                // or every future run would re-offer the same file.
                skipped++
                prefs.raiseWatermark(item.addedAt)
                continue
            }

            try {
                prefs.beginItem(item.name, index + 1, pending.size, item.size)
                // Refreshed per item, so the claim lives exactly as long as the
                // run keeps making progress.
                prefs.holdLock()
                client.upload(item, folderId) { sent ->
                    prefs.currentSent = sent
                    // Checked between chunks, so a request from the card lands
                    // within one chunk rather than at the end of a 2 GB video.
                    when (prefs.takeControl()) {
                        BackupPrefs.CONTROL_SKIP -> throw SkipRequested()
                        BackupPrefs.CONTROL_STOP -> throw StopRequested()
                    }
                }
                stored++
                prefs.raiseWatermark(item.addedAt)
            } catch (skip: SkipRequested) {
                // The user does not want this one. Step over it for good, or
                // the next run would offer it again and they would have to say
                // so every couple of hours.
                skipped++
                prefs.raiseWatermark(item.addedAt)
            } catch (stop: StopRequested) {
                stopped = true
                break
            } catch (signedOut: NotSignedInException) {
                finish("Signed out mid-run — $stored saved before that.")
                return@withContext Result.success()
            } catch (permanent: PermanentUploadException) {
                // The server will never accept this one. Move past it, or the
                // whole backup stalls behind a single bad file forever.
                skipped++
                prefs.raiseWatermark(item.addedAt)
            } catch (error: Throwable) {
                // Network died, server hiccuped, phone lost Wi-Fi. Stop the run
                // and let WorkManager back off; the watermark is still correct.
                //
                // Both of these matter and neither was here before: without the
                // log there is no way to find out afterwards what stopped a run,
                // and without the reason in the summary the card says "paused,
                // will retry" for ever while the user has no idea whether to
                // wait, reconnect, or report a bug.
                Log.w(TAG, "upload of ${item.name} failed, pausing the run", error)
                transientReason = error.message?.take(80)?.ifBlank { null }
                    ?: error.javaClass.simpleName
                transientFailure = true
                break
            }
        }

        prefs.addUploaded(stored)
        prefs.clearCurrent()
        // Released before the next batch is queued, or the chain would stand
        // down against itself.
        prefs.releaseLock()
        val summary = buildString {
            append("$stored saved")
            if (skipped > 0) append(", $skipped skipped")
            if (stopped) append(" — stopped")
            if (transientFailure) {
                append(" — paused, will retry")
                transientReason?.let { append(" ($it)") }
            }
        }
        finish(summary)

        // Keep going while there is more, the run was healthy, and this one
        // actually moved: without the progress guard a batch that achieves
        // nothing would queue another identical batch for ever.
        //
        // Deliberately not a loop inside one worker. Each batch is its own run,
        // so the constraints are re-evaluated between them — losing Wi-Fi or
        // dropping to a low battery ends the chain at the next boundary rather
        // than part-way through a file — and no single run outstays the time a
        // foreground service is allowed.
        if (!stopped && !transientFailure && prefs.enabled && (stored + skipped) > 0) {
            val remaining = runCatching { scanner.pendingCount(prefs) }.getOrDefault(0)
            if (remaining > 0) {
                Log.i(TAG, "$remaining still waiting; queueing the next batch")
                runCatching { BackupScheduler.continueRun(applicationContext, prefs) }
            }
        }

        // Retry only when something was actually left undone by a fault. A run
        // that merely hit the batch limit returns success; the chain above, or
        // the next scheduled run, picks up the rest.
        if (!stopped && transientFailure && stored == 0) Result.retry() else Result.success()
    }

    /** The card asked for this one file to be abandoned. */
    private class SkipRequested : RuntimeException()

    /** The card asked for the whole run to end now. */
    private class StopRequested : RuntimeException()

    private fun finish(result: String) {
        prefs.lastRunAt = System.currentTimeMillis()
        prefs.lastResult = result
    }

    /**
     * Promote to a foreground service, and carry on if that is refused.
     *
     * From Android 12 a background-started foreground service can be refused
     * outright, and on 13+ the notification needs a permission the user may
     * have denied. Neither is a reason to abandon the upload — it just runs
     * with a shorter leash — so this never throws.
     */
    private suspend fun setForegroundSafely(done: Int, total: Int, current: String? = null) {
        runCatching { setForeground(notification(done, total, current)) }
    }

    private fun notification(done: Int, total: Int, current: String?): ForegroundInfo {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Photo backup", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while new photos and videos are being saved to TeleDrive."
                    setShowBadge(false)
                }
            )
        }

        val text = current?.let { "$it  ($done of $total)" } ?: "Looking for new photos…"
        val builder = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setContentTitle("Backing up to TeleDrive")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setProgress(total.coerceAtLeast(1), done, total == 0)

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, builder.build())
        }
    }

    companion object {
        const val BASE_URL = "https://teledrive-codex.vercel.app"
        const val TAG = "TeleDriveBackup"
        const val CHANNEL = "teledrive-backup"
        const val NOTIFICATION_ID = 4821

        /**
         * Files per run. WorkManager gives a worker about ten minutes before it
         * is stopped, so a run has to be a slice of the backlog rather than all
         * of it. Fifty phone photos is comfortably inside that; a first run on a
         * full camera roll simply takes several runs, which is fine because the
         * watermark makes each one pick up where the last stopped.
         */
        const val BATCH_LIMIT = 50
    }
}
