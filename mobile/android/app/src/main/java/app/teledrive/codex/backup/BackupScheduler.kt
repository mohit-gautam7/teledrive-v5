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
    private const val INTERVAL_HOURS = 2L

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
        val request = PeriodicWorkRequestBuilder<BackupWorker>(
            INTERVAL_HOURS, TimeUnit.HOURS,
            30, TimeUnit.MINUTES
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

    fun runNow(context: Context, prefs: BackupPrefs): Operation {
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(if (prefs.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                    .build()
            )
            .build()
        return WorkManager.getInstance(context)
            .enqueueUniqueWork(ONE_SHOT, ExistingWorkPolicy.REPLACE, request)
    }

    /** Is a run happening or waiting right now? For the UI's status line. */
    fun isActive(context: Context): Boolean {
        val manager = WorkManager.getInstance(context)
        val states = (manager.getWorkInfosForUniqueWork(PERIODIC).get() +
            manager.getWorkInfosForUniqueWork(ONE_SHOT).get())
        return states.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }
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
