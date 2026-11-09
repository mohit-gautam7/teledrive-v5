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

    /* ── What the run is doing right now, for the UI to show ────────────────── */

    /*
     * Live progress, written as the bytes move.
     *
     * A backup that says only "running" is indistinguishable from one that is
     * stuck, which is the single most common reason people switch this kind of
     * feature off: there is no way to tell patience from a bug. These let the
     * card name the file and show the bar.
     */

    var currentName: String
        get() = prefs.getString(KEY_CUR_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CUR_NAME, value).apply()

    /** 1-based position within this run's batch, for "7 of 50". */
    var currentIndex: Int
        get() = prefs.getInt(KEY_CUR_INDEX, 0)
        set(value) = prefs.edit().putInt(KEY_CUR_INDEX, value).apply()

    var currentTotal: Int
        get() = prefs.getInt(KEY_CUR_TOTAL, 0)
        set(value) = prefs.edit().putInt(KEY_CUR_TOTAL, value).apply()

    var currentSent: Long
        get() = prefs.getLong(KEY_CUR_SENT, 0L)
        set(value) = prefs.edit().putLong(KEY_CUR_SENT, value).apply()

    var currentSize: Long
        get() = prefs.getLong(KEY_CUR_SIZE, 0L)
        set(value) = prefs.edit().putLong(KEY_CUR_SIZE, value).apply()

    fun beginItem(name: String, index: Int, total: Int, size: Long) {
        prefs.edit()
            .putString(KEY_CUR_NAME, name)
            .putInt(KEY_CUR_INDEX, index)
            .putInt(KEY_CUR_TOTAL, total)
            .putLong(KEY_CUR_SENT, 0L)
            .putLong(KEY_CUR_SIZE, size)
            .apply()
    }

    /** Nothing is in flight any more; the card should stop showing a bar. */
    fun clearCurrent() {
        prefs.edit()
            .remove(KEY_CUR_NAME)
            .remove(KEY_CUR_INDEX)
            .remove(KEY_CUR_TOTAL)
            .remove(KEY_CUR_SENT)
            .remove(KEY_CUR_SIZE)
            .apply()
    }

    /*
     * A request from the UI to the worker, which is in another process-less
     * life of its own and cannot be called directly.
     *
     * SharedPreferences is the only channel both sides already share, and the
     * worker reads it between chunks — so "skip" and "stop" land within a few
     * megabytes rather than at the end of the file. Cleared by whoever acts on
     * it, so a stale request cannot cancel a later run.
     */
    var control: String
        get() = prefs.getString(KEY_CONTROL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CONTROL, value).apply()

    fun takeControl(): String {
        val value = control
        if (value.isNotEmpty()) control = ""
        return value
    }

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

    companion object {
        const val KEY_ENABLED = "enabled"
        const val KEY_WATERMARK = "watermark"
        const val KEY_WIFI_ONLY = "wifiOnly"
        const val KEY_CHARGING_ONLY = "chargingOnly"
        const val KEY_FOLDER = "folderId"
        const val KEY_INCLUDE_NON_CAMERA = "includeNonCamera"
        const val KEY_LAST_RUN = "lastRunAt"
        const val KEY_LAST_RESULT = "lastResult"
        const val KEY_UPLOADED_TOTAL = "uploadedTotal"
        const val KEY_CUR_NAME = "currentName"
        const val KEY_CUR_INDEX = "currentIndex"
        const val KEY_CUR_TOTAL = "currentTotal"
        const val KEY_CUR_SENT = "currentSent"
        const val KEY_CUR_SIZE = "currentSize"
        const val KEY_CONTROL = "control"
        const val CONTROL_SKIP = "skip"
        const val CONTROL_STOP = "stop"
    }
}
