package app.teledrive.codex.backup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
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

        val client = TeleDriveClient(applicationContext, BASE_URL)

        try {
            client.whoAmI()
        } catch (signedOut: NotSignedInException) {
            // Not a failure to retry: no amount of waiting signs a user in.
            // The schedule stays, so backup resumes by itself once they do.
            finish("Signed out — open TeleDrive and sign in.")
            return@withContext Result.success()
        } catch (offline: IOException) {
            return@withContext Result.retry()
        }

        val pending = scanner.scan(prefs, BATCH_LIMIT)
        if (pending.isEmpty()) {
            finish("Up to date.")
            return@withContext Result.success()
        }

        setForegroundSafely(0, pending.size)

        val already = runCatching { client.findExisting(pending, prefs.folderId) }.getOrDefault(emptySet())
        var stored = 0
        var skipped = 0
        var transientFailure = false

        for ((index, item) in pending.withIndex()) {
            if (isStopped) break
            setForegroundSafely(index, pending.size, item.name)

            if (already.contains(index)) {
                // Already in the drive: step over it and let the watermark pass,
                // or every future run would re-offer the same file.
                skipped++
                prefs.raiseWatermark(item.addedAt)
                continue
            }

            try {
                client.upload(item, prefs.folderId) { }
                stored++
                prefs.raiseWatermark(item.addedAt)
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
                transientFailure = true
                break
            }
        }

        prefs.addUploaded(stored)
        val summary = buildString {
            append("$stored saved")
            if (skipped > 0) append(", $skipped skipped")
            if (transientFailure) append(" — paused, will retry")
        }
        finish(summary)

        // Retry only when something was actually left undone by a fault. A run
        // that merely hit the batch limit returns success; the next scheduled
        // run picks up the rest, which keeps one huge backlog from monopolising
        // the device.
        if (transientFailure && stored == 0) Result.retry() else Result.success()
    }

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
