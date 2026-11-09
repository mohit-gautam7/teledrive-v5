package app.teledrive.codex.backup

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * The web app's handle on the native backup.
 *
 * TeleDrive's UI is the website, loaded in this app's WebView, so the settings
 * for a feature the website cannot implement still have to live there. This
 * plugin is the entire surface between them: the page calls these methods when
 * `window.Capacitor` exists and hides the whole section when it does not, which
 * is why the website needs no Capacitor dependency to stay a normal website.
 *
 * Nothing here uploads anything. It schedules, reports and asks for
 * permissions; [BackupWorker] does the work, on WorkManager's clock, whether
 * this plugin or the WebView or the app itself exists at that moment.
 */
@CapacitorPlugin(
    name = "Backup",
    permissions = [
        Permission(
            alias = BackupPlugin.MEDIA_13,
            strings = [Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO]
        ),
        Permission(alias = BackupPlugin.MEDIA_LEGACY, strings = [Manifest.permission.READ_EXTERNAL_STORAGE]),
        Permission(alias = BackupPlugin.NOTIFICATIONS, strings = [Manifest.permission.POST_NOTIFICATIONS])
    ]
)
class BackupPlugin : Plugin() {

    private val prefs: BackupPrefs by lazy { BackupPrefs(context) }

    /* ── Status ────────────────────────────────────────────────────────────── */

    @PluginMethod
    fun status(call: PluginCall) {
        val granted = hasMediaPermission()
        // Counting means querying MediaStore, which needs the permission we may
        // not have — so it is reported as unknown rather than as zero. Zero
        // would read as "nothing to back up", the opposite of the truth.
        val pending = if (granted) runCatching { MediaScanner(context).pendingCount(prefs) }.getOrNull() else null

        call.resolve(
            JSObject()
                .put("available", true)
                .put("enabled", prefs.enabled)
                .put("mediaPermission", granted)
                .put("notificationPermission", hasNotificationPermission())
                .put("batteryExempt", isBatteryExempt())
                .put("vendor", vendorLabel())
                .put("needsStartupPermission", startupSettingsIntent() != null)
                .put("pending", pending ?: -1)
                .put("running", runCatching { BackupScheduler.isActive(context) }.getOrDefault(false))
                .put("wifiOnly", prefs.wifiOnly)
                .put("chargingOnly", prefs.chargingOnly)
                .put("includeNonCamera", prefs.includeNonCamera)
                .put("folderId", prefs.folderId)
                .put("lastRunAt", prefs.lastRunAt)
                .put("lastResult", prefs.lastResult)
                .put("uploadedTotal", prefs.uploadedTotal)
        )
    }

    /* ── Turning it on and off ─────────────────────────────────────────────── */

    @PluginMethod
    fun enable(call: PluginCall) {
        if (!hasMediaPermission()) {
            // Enabling without the permission would schedule work that can only
            // ever fail, and the user would see "on" next to a backup that never
            // happens. Ask first; the UI retries enable() once granted.
            requestPermissionForAlias(mediaAlias(), call, "mediaPermissionResult")
            return
        }
        prefs.enabled = true
        BackupScheduler.schedule(context, prefs)
        status(call)
    }

    @PermissionCallback
    private fun mediaPermissionResult(call: PluginCall) {
        if (!hasMediaPermission()) {
            call.reject("Photo access is needed before TeleDrive can back anything up.")
            return
        }
        prefs.enabled = true
        BackupScheduler.schedule(context, prefs)
        status(call)
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        prefs.enabled = false
        BackupScheduler.cancel(context)
        status(call)
    }

    @PluginMethod
    fun runNow(call: PluginCall) {
        if (!prefs.enabled) {
            call.reject("Backup is switched off.")
            return
        }
        BackupScheduler.runNow(context, prefs)
        status(call)
    }

    /**
     * Forget the watermark so the next run re-examines the whole camera roll.
     *
     * For photos copied onto the phone with an old timestamp, which sit below
     * the watermark and would otherwise never be seen. Nothing is uploaded
     * twice — the server's duplicate check catches what is already stored.
     */
    @PluginMethod
    fun rescanAll(call: PluginCall) {
        prefs.resetWatermark()
        if (prefs.enabled) BackupScheduler.runNow(context, prefs)
        status(call)
    }

    @PluginMethod
    fun setOptions(call: PluginCall) {
        call.getBoolean("wifiOnly")?.let { prefs.wifiOnly = it }
        call.getBoolean("chargingOnly")?.let { prefs.chargingOnly = it }
        call.getBoolean("includeNonCamera")?.let { prefs.includeNonCamera = it }
        if (call.data.has("folderId")) prefs.folderId = call.getString("folderId")
        // Constraints are baked into the enqueued work, so a changed setting
        // only takes effect once the schedule is rebuilt.
        if (prefs.enabled) BackupScheduler.schedule(context, prefs)
        status(call)
    }

    /* ── Permissions and the vendor obstacle course ────────────────────────── */

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasNotificationPermission()) {
            status(call)
            return
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "notificationResult")
    }

    @PermissionCallback
    private fun notificationResult(call: PluginCall) = status(call)

    /**
     * Show the system's own "allow this app to ignore battery optimisation"
     * prompt. The user decides; this only opens the dialog.
     */
    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        if (isBatteryExempt()) {
            status(call)
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
        if (!launch(intent)) {
            // Some ROMs remove the direct dialog. The list screen is the
            // fallback, and the settings app is the fallback for that.
            launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) ||
                launch(appDetailsIntent())
        }
        status(call)
    }

    /**
     * Open the vendor's own autostart list.
     *
     * On ColorOS, OxygenOS and their relatives, the standard battery exemption
     * is not sufficient: a separate "startup manager" decides whether the app
     * may be launched by the system at all, and WorkManager's alarms are
     * silently dropped for apps that are not on it. There is no API for this
     * and no way to detect the setting's value — only to open the screen and
     * explain what to toggle, which is what the UI does alongside this call.
     */
    @PluginMethod
    fun openStartupSettings(call: PluginCall) {
        val intent = startupSettingsIntent()
        val opened = if (intent != null) launch(intent) else false
        if (!opened) launch(appDetailsIntent())
        call.resolve(JSObject().put("opened", opened).put("vendor", vendorLabel()))
    }

    /* ── Plumbing ──────────────────────────────────────────────────────────── */

    private fun mediaAlias() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) MEDIA_13 else MEDIA_LEGACY

    private fun hasMediaPermission(): Boolean {
        val needed =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
            else listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        return needed.all {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun isBatteryExempt(): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun launch(intent: Intent): Boolean = runCatching {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // resolveActivity first: a missing component throws, and on these ROMs
        // half of these screens exist only on some firmware versions.
        if (intent.resolveActivity(context.packageManager) == null) return false
        context.startActivity(intent)
        true
    }.getOrDefault(false)

    private fun appDetailsIntent() =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:${context.packageName}"))

    private fun vendorLabel(): String = Build.MANUFACTURER.lowercase()

    /**
     * The autostart screen for this manufacturer, if one is known.
     *
     * These are undocumented component names that move between firmware
     * versions, which is why every one is tried in turn and a failure is not an
     * error — the UI falls back to telling the user where to look.
     */
    private fun startupSettingsIntent(): Intent? {
        val candidates: List<Pair<String, String>> = when (vendorLabel()) {
            "oppo", "realme" -> listOf(
                "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
                "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
                "com.coloros.oppoguardelf" to "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"
            )
            "oneplus" -> listOf(
                "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
                "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListAlias"
            )
            "vivo" -> listOf(
                "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
                "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
            )
            "xiaomi", "redmi", "poco" -> listOf(
                "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity"
            )
            "samsung" -> listOf(
                "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity"
            )
            "huawei" -> listOf(
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
            )
            else -> emptyList()
        }

        for ((pkg, cls) in candidates) {
            val intent = Intent().setComponent(ComponentName(pkg, cls))
            if (intent.resolveActivity(context.packageManager) != null) return intent
        }
        return null
    }

    companion object {
        const val MEDIA_13 = "media"
        const val MEDIA_LEGACY = "mediaLegacy"
        const val NOTIFICATIONS = "notifications"
    }
}
