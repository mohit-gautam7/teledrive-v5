package app.teledrive.codex

import android.os.Bundle
import android.webkit.CookieManager
import app.teledrive.codex.backup.BackupPlugin
import app.teledrive.codex.backup.BackupPrefs
import app.teledrive.codex.backup.BackupScheduler
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must happen before super.onCreate, which builds the bridge and reads
        // the plugin list.
        registerPlugin(BackupPlugin::class.java)
        super.onCreate(savedInstanceState)

        // The session cookie is the backup worker's only credential, and a
        // WebView drops session cookies when the process dies unless they are
        // flushed. Without this, backup works until the first time Android
        // reclaims the app and then quietly reports "signed out" forever.
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().flush()
    }

    override fun onPause() {
        super.onPause()
        // Flush on the way out too: leaving the app is exactly when the process
        // is most likely to be killed.
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        val prefs = BackupPrefs(this)
        if (!prefs.enabled) return
        // Make sure the schedule survived whatever the OS did while we were
        // away, without restarting its countdown - see BackupScheduler.schedule.
        runCatching { BackupScheduler.ensureScheduled(this, prefs) }
        // And start a run if none is going. Opening the app is what people do
        // when they suspect backup has stopped, so it should be the thing that
        // restarts it. Off the main thread: it reads WorkManager's database.
        val app = applicationContext
        Thread { runCatching { BackupScheduler.kickIfIdle(app, prefs) } }.start()
    }
}
