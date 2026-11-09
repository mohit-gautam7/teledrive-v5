package app.teledrive.codex.backup

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Put the schedule back after a reboot or an app update.
 *
 * WorkManager normally restores its own periodic work, so on stock Android this
 * is belt and braces. It is not redundant on the ROMs this app is actually for:
 * ColorOS and OxygenOS clear pending jobs for apps they consider inactive, and
 * an app whose backup silently stopped three weeks ago is worse than one that
 * never worked, because nobody checks.
 *
 * Re-scheduling is idempotent — enqueueUniquePeriodicWork with the same name
 * replaces rather than duplicates — so running this more often than strictly
 * necessary costs nothing.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        val prefs = BackupPrefs(context)
        if (!prefs.enabled) return
        BackupScheduler.ensureScheduled(context, prefs)
    }
}
