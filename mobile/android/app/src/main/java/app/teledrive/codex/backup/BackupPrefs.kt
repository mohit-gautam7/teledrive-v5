package app.teledrive.codex.backup

import android.content.Context
import android.content.SharedPreferences

/**
 * Everything the backup remembers between runs.
 *
 * The important one is [watermark]: the DATE_ADDED of the newest item that has
 * been dealt with. The scan asks MediaStore for "anything added after this",
 * which is the only question that stays cheap as the camera roll grows — a
 * phone with 40,000 photos must not re-list all of them every three hours.
 *
 * The watermark advances only after a file is actually stored, never when it is
 * merely queued, so a run killed halfway resumes instead of skipping. The cost
 * of that choice is re-examining a handful of already-stored items on the next
 * run, which the server's duplicate check answers in one request.
 *
 * A photo copied onto the phone with an old timestamp has an old DATE_ADDED and
 * therefore sits below the watermark forever. That is what [resetWatermark] is
 * for, and why the UI offers "Re-check everything" rather than pretending the
 * watermark is infallible.
 */
class BackupPrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("teledrive.backup", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    /** Seconds since the epoch — MediaStore's own unit for DATE_ADDED. */
    var watermark: Long
        get() = prefs.getLong(KEY_WATERMARK, 0L)
        set(value) = prefs.edit().putLong(KEY_WATERMARK, value).apply()

    /** Only advance, never retreat: two runs can finish out of order. */
    fun raiseWatermark(seconds: Long) {
        if (seconds > watermark) watermark = seconds
    }

    fun resetWatermark() {
        prefs.edit().putLong(KEY_WATERMARK, 0L).apply()
    }

    /** Unmetered networks only. On by default: a camera roll is gigabytes. */
    var wifiOnly: Boolean
        get() = prefs.getBoolean(KEY_WIFI_ONLY, true)
        set(value) = prefs.edit().putBoolean(KEY_WIFI_ONLY, value).apply()

    /**
     * Wait for the charger. Off by default — on a phone that is rarely plugged
     * in, this quietly means "never back up", which looks identical to a bug.
     */
    var chargingOnly: Boolean
        get() = prefs.getBoolean(KEY_CHARGING_ONLY, false)
        set(value) = prefs.edit().putBoolean(KEY_CHARGING_ONLY, value).apply()

    /** Destination folder id in TeleDrive, or null for the drive root. */
    var folderId: String?
        get() = prefs.getString(KEY_FOLDER, null)
        set(value) = prefs.edit().putString(KEY_FOLDER, value).apply()

    /** Also back up screenshots, WhatsApp media and the rest of Pictures/. */
    var includeNonCamera: Boolean
        get() = prefs.getBoolean(KEY_INCLUDE_NON_CAMERA, false)
        set(value) = prefs.edit().putBoolean(KEY_INCLUDE_NON_CAMERA, value).apply()

    /* ── What the last run did, for the UI to show ──────────────────────────── */

    var lastRunAt: Long
        get() = prefs.getLong(KEY_LAST_RUN, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_RUN, value).apply()

    var lastResult: String
        get() = prefs.getString(KEY_LAST_RESULT, "") ?: ""
        set(value) = prefs.edit().putString(KEY_LAST_RESULT, value).apply()

    var uploadedTotal: Int
        get() = prefs.getInt(KEY_UPLOADED_TOTAL, 0)
        set(value) = prefs.edit().putInt(KEY_UPLOADED_TOTAL, value).apply()

    fun addUploaded(count: Int) {
        if (count > 0) uploadedTotal += count
    }

    private companion object {
        const val KEY_ENABLED = "enabled"
        const val KEY_WATERMARK = "watermark"
        const val KEY_WIFI_ONLY = "wifiOnly"
        const val KEY_CHARGING_ONLY = "chargingOnly"
        const val KEY_FOLDER = "folderId"
        const val KEY_INCLUDE_NON_CAMERA = "includeNonCamera"
        const val KEY_LAST_RUN = "lastRunAt"
        const val KEY_LAST_RESULT = "lastResult"
        const val KEY_UPLOADED_TOTAL = "uploadedTotal"
    }
}
