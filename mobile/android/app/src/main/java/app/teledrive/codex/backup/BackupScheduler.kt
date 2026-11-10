package app.teledrive.codex.backup

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Operation
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * When the backup runs.
 *
 * Two entry points, deliberately separate:
 *
 *   - [schedule] installs the repeating job. WorkManager owns it from then on,
 *     including across reboots, and it is the thing that makes this work with
 *     the app closed.
 *   - [runNow] is the button. It ignores the battery and interval constraints
 *     because the user is standing there watching, but keeps the network one —
 *     "back up now" over mobile data when they asked for Wi-Fi only would be
 *     an expensive surprise.
 */
object BackupScheduler {

    private const val PERIODIC = "teledrive-backup-periodic"
    private const val ONE_SHOT = "teledrive-backup-now"

    /**
     * Two hours.
     *
     * WorkManager's floor is fifteen minutes, and anything near it on a phone
     * that takes a dozen photos a day is a battery complaint waiting to happen.
     * Two hours means the longest a photo waits is two hours, which is what
     * "it just happens" actually feels like, and the flex window lets Android
     * align the run with whatever else wakes the device.
     */
    /** Used when a preference has never been written. */
    private const val DEFAULT_INTERVAL_HOURS = 2

    /** First wait after a paused one-shot run; doubles from there. */
    private const val RETRY_MINUTES = 1L

    private const val KICK_THROTTLE_MS = 2 * 60 * 1000L

    /**
     * Install or replace the repeating job.
     *
     * [replaceExisting] is the whole subtlety. A settings change must take
     * effect now, so it replaces. But the app calls this on every resume, and
     * replacing there would restart the two-hour countdown each time the user
     * opened TeleDrive — on a phone opened a dozen times a day the periodic run
     * would simply never arrive. That path keeps whatever is already pending.
     */
    @JvmOverloads
    fun schedule(context: Context, prefs: BackupPrefs, replaceExisting: Boolean = true) {
        // The flex window is a third of the period, so a long interval keeps a
        // sensible amount of slack for the system to batch the wake-up with
        // other work instead of waking the radio on its own.
        val hours = prefs.intervalHours.toLong().coerceAtLeast(1L)
        val flexMinutes = (hours * 60 / 3).coerceAtLeast(15L)
        val request = PeriodicWorkRequestBuilder<BackupWorker>(
            hours, TimeUnit.HOURS,
            flexMinutes, TimeUnit.MINUTES
        )
            .setConstraints(constraints(prefs))
            // A failed run waits 15 minutes, then half an hour, then an hour.
            // Hammering a server that is down helps nobody and costs battery.
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC,
            if (replaceExisting) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    /** For app resume and boot: make sure a schedule exists, disturb nothing. */
    fun ensureScheduled(context: Context, prefs: BackupPrefs) =
        schedule(context, prefs, replaceExisting = false)

    /**
     * End a "Back up now" run, leaving the schedule alone.
     *
     * Only the one-shot is cancelled. Cancelling the periodic work would take
     * the whole schedule with it, which is switching backup off, not stopping
     * a run — so a periodic run is ended by the stop flag the worker reads
     * between chunks instead.
     */
    fun cancelRun(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(ONE_SHOT)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(ONE_SHOT)
    }

    /**
     * Queue another batch straight after this one.
     *
     * A run handles one batch and stops, so a first backup of 750 photos would
     * take fifteen scheduled runs — thirty hours of waiting two hours at a
     * time — which is not a backup anyone would describe as working.
     *
     * APPEND_OR_REPLACE rather than REPLACE because the caller is the worker
     * that currently owns this unique name: REPLACE would cancel the very run
     * asking for the next one. Appending puts the new batch behind it, so the
     * chain advances one batch at a time and never runs two at once.
     *
     * The constraints are rebuilt per batch, so Wi-Fi going away or the
     * battery dropping stops the chain exactly as it stops a scheduled run.
     */
    fun continueRun(context: Context, prefs: BackupPrefs): Operation {
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setConstraints(constraints(prefs))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, RETRY_MINUTES, TimeUnit.MINUTES)
            .build()
        return WorkManager.getInstance(context)
            .enqueueUniqueWork(ONE_SHOT, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    fun runNow(context: Context, prefs: BackupPrefs): Operation {
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(if (prefs.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                    .build()
            )
            // A run that pauses on a network blip comes back in a minute, then
            // two, then four. Without this a pause after some progress waited
            // for the next scheduled run, which on a daily schedule is a day.
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, RETRY_MINUTES, TimeUnit.MINUTES)
            .build()
        return WorkManager.getInstance(context)
            .enqueueUniqueWork(ONE_SHOT, ExistingWorkPolicy.REPLACE, request)
    }

    /**
     * Start a run now, unless one is already going.
     *
     * Called when the app comes to the front. On phones whose battery manager
     * refuses to start apps in the background — ColorOS without auto-launch is
     * the one this was written on — nothing WorkManager schedules will fire
     * once the process has been killed, and the old resume path only
     * re-registered the schedule. So opening the app, the one thing a user
     * does when they suspect backup has stopped, did not restart it.
     *
     * REPLACE is right here and only here: with nothing running, whatever is
     * queued is at best waiting out a backoff, and the user being present is a
     * better signal than any timer. A run in flight is left alone — replacing
     * it would cancel a file mid-upload to start the same file again.
     */
    fun kickIfIdle(context: Context, prefs: BackupPrefs) {
        val now = System.currentTimeMillis()
        // The activity resumes after every permission dialog and task switch;
        // one kick covers a burst of them.
        if (now - lastKickAt < KICK_THROTTLE_MS) return
        lastKickAt = now
        if (isActive(context)) return
        runNow(context, prefs)
    }

    @Volatile
    private var lastKickAt = 0L

    /** Is a run happening or waiting right now? For the UI's status line. */
    /**
     * Is a run happening *now* — not merely scheduled.
     *
     * ENQUEUED used to count, which made "Running now" show for the entire two
     * hours between runs, and the card cannot tell a stuck upload from an idle
     * schedule if both look the same. It also decides how often the page polls,
     * so counting ENQUEUED meant polling every 1.5 seconds around the clock for
     * a worker that was not running.
     */
    fun isActive(context: Context): Boolean {
        val manager = WorkManager.getInstance(context)
        val states = (manager.getWorkInfosForUniqueWork(PERIODIC).get() +
            manager.getWorkInfosForUniqueWork(ONE_SHOT).get())
        return states.any { it.state == WorkInfo.State.RUNNING }
    }

    private fun constraints(prefs: BackupPrefs) = Constraints.Builder()
        .setRequiredNetworkType(if (prefs.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(prefs.chargingOnly)
        // Not setRequiresBatteryNotLow(false): a phone under 15% should not be
        // spending what is left pushing video to Telegram.
        .setRequiresBatteryNotLow(true)
        .setRequiresStorageNotLow(false)
        .build()
}
