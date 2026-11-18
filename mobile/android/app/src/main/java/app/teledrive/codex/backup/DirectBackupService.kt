package app.teledrive.codex.backup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps TeleDrive alive while a *direct* backup runs.
 *
 * Direct backup uploads from the app's own page with the device's Telegram
 * session — nothing goes through the file server. That page only keeps running
 * while the process does, so once the user switches away, Android would freeze
 * or kill it. A foreground service (with the notification Android requires) and
 * a partial wake lock keep the process and CPU going until the run finishes or
 * the page stops it.
 */
class DirectBackupService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Saving new photos straight to your Telegram…"
        val notification = notification(this, text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            // Bounded: a run that never reports back cannot hold the CPU forever.
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TeleDrive:directBackup").apply { acquire(2 * 60 * 60 * 1000L) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 4822
        const val ACTION_STOP = "app.teledrive.codex.backup.STOP_DIRECT"
        const val EXTRA_TEXT = "text"

        fun start(context: Context, text: String? = null) {
            // The "N new to back up" prompt has done its job once a run starts.
            androidx.core.app.NotificationManagerCompat.from(context).cancel(BackupWorker.PENDING_NOTIFICATION_ID)
            val intent = Intent(context, DirectBackupService::class.java).putExtra(EXTRA_TEXT, text)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DirectBackupService::class.java))
        }

        private fun notification(context: Context, text: String) =
            NotificationCompat.Builder(context, channel(context))
                .setContentTitle("Backing up to Telegram")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openApp(context))
                .build()

        /** Opens TeleDrive; opening it starts a direct backup by itself. */
        fun openApp(context: Context): PendingIntent? {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        fun channel(context: Context): String {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                    NotificationChannel(BackupWorker.CHANNEL, "Photo backup", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shown while new photos and videos are being saved to TeleDrive."
                        setShowBadge(false)
                    }
                )
            }
            return BackupWorker.CHANNEL
        }
    }
}
