package app.teledrive.codex.backup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
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
 * away. Everything else here is in service of the ways naive backup code goes
 * wrong, most of which were found the hard way on a real phone:
 *
 *   1. **Being killed mid-run.** Items are processed oldest-first and the
 *      watermark is raised only after each file is stored, so a run that dies
 *      halfway resumes exactly where it stopped instead of skipping the rest.
 *   2. **Running twice at once.** The scheduled job and "back up now" are
 *      separate pieces of work, so a lock makes them take turns — and the lock
 *      knows its owner, so a run restarted after a kill is not locked out by
 *      the claim it left behind.
 *   3. **Stalling behind one file.** A file the server refuses is stepped over
 *      at once. A file that fails for reasons of its own three runs in a row is
 *      set aside and reported. Failures of the network are never counted
 *      against a file, or a long outage would discard the camera roll.
 *   4. **Pausing and not coming back.** Every pause is a retry with a short
 *      backoff, never a wait for the next scheduled run.
 *   5. **Being invisible.** A long upload without a visible notification is
 *      what vendor battery managers kill first, so the work promotes itself to
 *      the foreground before it starts moving bytes.
 */
class BackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val prefs = BackupPrefs(context)
    private val scanner = MediaScanner(context)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (!prefs.enabled) return@withContext Result.success()

        // WorkManager gives the same id back when it restarts work whose
        // process was killed, which is what lets a run reclaim its own lock.
        val me = id.toString()
        if (!prefs.tryAcquireLock(me)) {
            // Retry, not success. Success would consume this piece of work, and
            // if the run holding the lock is in fact dead — its process killed,
            // its claim merely not yet expired — nothing would be left queued
            // to carry on. Coming back in a minute costs one preference read.
            Log.i(TAG, "another run holds the lock; looking again shortly")
            return@withContext Result.retry()
        }

        try {
            runBatch(me)
        } finally {
            // One release for every way out, instead of one per early return —
            // six of them, each a chance to forget. The next batch is queued
            // behind this one and cannot start until this has returned.
            prefs.releaseLock(me)
        }
    }

    private suspend fun runBatch(me: String): Result {
        // A run that ends normally clears its progress. Finding it still set
        // means the last run never reached its end: the process was killed
        // mid-file. Worth recording, because it is direct evidence of what the
        // settings card can otherwise only warn about in general terms.
        if (prefs.currentName.isNotEmpty()) {
            Log.w(TAG, "the previous run was cut off during ${prefs.currentName}")
            prefs.interruptedAt = System.currentTimeMillis()
            prefs.clearCurrent()
        }

        val client = TeleDriveClient(applicationContext, BASE_URL)

        try {
            client.whoAmI()
        } catch (signedOut: NotSignedInException) {
            // Not a failure to retry: no amount of waiting signs a user in.
            // The schedule stays, so backup resumes by itself once they do.
            finish("Signed out — open TeleDrive and sign in.")
            return Result.success()
        } catch (offline: IOException) {
            return Result.retry()
        }

        val pending = scanner.scan(prefs, BATCH_LIMIT)
        if (pending.isEmpty()) {
            finish("Up to date.")
            return Result.success()
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
            finish("Signed out — open TeleDrive and sign in.")
            return Result.success()
        } catch (error: Throwable) {
            Log.w(TAG, "could not resolve the backup folder", error)
            return Result.retry()
        }

        setForegroundSafely(0, pending.size)

        val already = runCatching { client.findExisting(pending, folderId) }.getOrDefault(emptySet())
        var stored = 0
        var skipped = 0
        var setAside = 0
        var pausedBecause: String? = null
        var stopped = false
        var signedOut = false

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
            prefs.refreshLock(me)

            if (already.contains(index)) {
                // Already in the drive: step over it and let the watermark pass,
                // or every future run would re-offer the same file.
                skipped++
                prefs.raiseWatermark(item.addedAt)
                continue
            }

            try {
                prefs.beginItem(item.name, index + 1, pending.size, item.size)
                client.upload(item, folderId) { sent ->
                    prefs.currentSent = sent
                    // Per chunk, not per file: a video that takes longer than
                    // the lock's lifetime would otherwise let a second run in
                    // half-way through it, which is how duplicates were made.
                    prefs.refreshLock(me)
                    // Also per chunk, so a request from the card lands within
                    // one chunk rather than at the end of a 2 GB video.
                    when (prefs.takeControl()) {
                        BackupPrefs.CONTROL_SKIP -> throw SkipRequested()
                        BackupPrefs.CONTROL_STOP -> throw StopRequested()
                    }
                }
                stored++
                prefs.raiseWatermark(item.addedAt)
                prefs.clearStrikes()
            } catch (skip: SkipRequested) {
                // The user does not want this one. Step over it for good, or
                // the next run would offer it again and they would have to say
                // so every couple of hours.
                skipped++
                prefs.raiseWatermark(item.addedAt)
            } catch (stop: StopRequested) {
                stopped = true
                break
            } catch (gone: NotSignedInException) {
                signedOut = true
                break
            } catch (permanent: PermanentUploadException) {
                // The server will never accept this one. Move past it, or the
                // whole backup stalls behind a single bad file forever.
                skipped++
                prefs.raiseWatermark(item.addedAt)
            } catch (unreadable: LocalReadException) {
                // The phone could not read its own file. That is about this
                // file and nothing else, so it earns a strike — and on the
                // third, the file is set aside so the rest can go.
                if (strikeOut(item, unreadable)) {
                    setAside++
                    continue
                }
                pausedBecause = reasonFor(unreadable)
                break
            } catch (error: Throwable) {
                // Network died, server hiccuped, phone lost Wi-Fi: stop the run
                // and come back shortly; the watermark is still correct.
                //
                // The one exception is a server that answers everything else
                // and keeps returning 5xx for this file. Asking whoAmI() is the
                // discriminator: if that works, the fault follows the file and
                // it earns a strike. If it does not, this is an outage, and an
                // outage must never count against a file — it fails all of them
                // equally, and striking for it would throw the camera roll away
                // one photo at a time.
                val aboutThisFile = error is ServerErrorException && runCatching { client.whoAmI() }.isSuccess
                if (aboutThisFile && strikeOut(item, error)) {
                    setAside++
                    continue
                }
                Log.w(TAG, "upload of ${item.name} failed, pausing the run", error)
                pausedBecause = reasonFor(error)
                break
            }
        }

        prefs.addUploaded(stored)
        prefs.clearCurrent()

        val summary = buildString {
            append("$stored saved")
            if (skipped > 0) append(", $skipped skipped")
            if (setAside > 0) append(", $setAside set aside")
            if (signedOut) append(" — signed out part-way; sign in to continue")
            if (stopped) append(" — stopped")
            // Without the reason the card says "paused, will retry" for ever
            // while the user has no idea whether to wait, reconnect, or report
            // a bug.
            pausedBecause?.let { append(" — paused, will retry ($it)") }
        }
        finish(summary)

        if (signedOut || stopped) return Result.success()

        // A pause is always a retry, whether or not this run stored anything
        // first. It used to be a retry only when nothing was stored; with
        // progress it reported success and waited for the next scheduled run,
        // which on a daily schedule turned a one-second DNS failure into a
        // day's delay. The watermark already holds whatever was stored, so the
        // retry picks up at the file that failed.
        if (pausedBecause != null) return Result.retry()

        // Keep going while there is more and this run actually moved: without
        // the progress guard a batch that achieves nothing would queue another
        // identical batch for ever.
        //
        // Deliberately not a loop inside one worker. Each batch is its own run,
        // so the constraints are re-evaluated between them — losing Wi-Fi or
        // dropping to a low battery ends the chain at the next boundary rather
        // than part-way through a file — and no single run outstays the time a
        // foreground service is allowed.
        if (prefs.enabled && (stored + skipped + setAside) > 0) {
            val remaining = runCatching { scanner.pendingCount(prefs) }.getOrDefault(0)
            if (remaining > 0) {
                Log.i(TAG, "$remaining still waiting; queueing the next batch")
                runCatching { BackupScheduler.continueRun(applicationContext, prefs) }
            }
        }
        return Result.success()
    }

    /**
     * Count a failure against [item]; true once it has had its last chance.
     *
     * Strikes one and two end the run, because skipping ahead without raising
     * the watermark is not possible — the watermark is a single line, and the
     * files behind this one would carry it past. So the file gets two more
     * runs to come good, a minute and then two apart, and only then is it set
     * aside, named in the card, and left for "Re-check everything".
     */
    private fun strikeOut(item: MediaItem, why: Throwable): Boolean {
        val strikes = prefs.strike(item.uri.toString())
        Log.w(TAG, "${item.name} failed, strike $strikes of ${BackupPrefs.MAX_STRIKES}", why)
        if (strikes < BackupPrefs.MAX_STRIKES) return false
        prefs.clearStrikes()
        prefs.addProblem(item.name)
        prefs.raiseWatermark(item.addedAt)
        return true
    }

    private fun reasonFor(error: Throwable): String =
        error.message?.take(80)?.ifBlank { null } ?: error.javaClass.simpleName

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
     * outright, on 13+ the notification needs a permission the user may have
     * denied, and on 15+ a dataSync service has a daily time allowance that can
     * run out during a first backup. None of those is a reason to abandon the
     * upload — it just runs with a shorter leash — so this never throws.
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
         * of it. Fifty phone photos is comfortably inside that; a full camera
         * roll is simply a chain of runs, each picking up at the watermark
         * where the last one stopped.
         */
        const val BATCH_LIMIT = 50
    }
}
