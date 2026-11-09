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

    /**
     * Which device albums to back up, as MediaStore relative paths
     * ("DCIM/Camera/", "Pictures/Screenshots/").
     *
     * Empty means "not chosen yet", and the scanner falls back to the camera
     * folders. It deliberately does not mean "none": a user who has not opened
     * the settings yet should still get their camera roll, and a backup that
     * silently covers nothing is the worst of the possible defaults.
     *
     * Paths rather than MediaStore bucket ids because a path survives a rescan
     * and reads the same in the UI, the prefs and the logs.
     */
    var albums: Set<String>
        get() = prefs.getStringSet(KEY_ALBUMS, emptySet())?.toSet() ?: emptySet()
        set(value) = prefs.edit().putStringSet(KEY_ALBUMS, value).apply()

    /** Back up photos. Off means images are never even queried. */
    var includePhotos: Boolean
        get() = prefs.getBoolean(KEY_INCLUDE_PHOTOS, true)
        set(value) = prefs.edit().putBoolean(KEY_INCLUDE_PHOTOS, value).apply()

    /** Back up videos. The usual reason to switch this off is a data plan. */
    var includeVideos: Boolean
        get() = prefs.getBoolean(KEY_INCLUDE_VIDEOS, true)
        set(value) = prefs.edit().putBoolean(KEY_INCLUDE_VIDEOS, value).apply()

    /**
     * Skip anything larger than this many megabytes. 0 means no limit.
     *
     * Excluded files are dropped by the scan rather than skipped by the worker,
     * so raising the cap later does not go back for them — the watermark has
     * moved on. "Re-check everything" is the way back, and the card says so.
     */
    var maxFileSizeMb: Int
        get() = prefs.getInt(KEY_MAX_FILE_MB, 0)
        set(value) = prefs.edit().putInt(KEY_MAX_FILE_MB, value.coerceAtLeast(0)).apply()

    /**
     * Hours between scheduled runs.
     *
     * Clamped to WorkManager's own floor of 15 minutes expressed in hours, so a
     * value from an older build or a hand-edited preference cannot produce a
     * schedule the platform silently rewrites behind our back.
     */
    var intervalHours: Int
        get() = prefs.getInt(KEY_INTERVAL_HOURS, 2).coerceIn(1, 24)
        set(value) = prefs.edit().putInt(KEY_INTERVAL_HOURS, value.coerceIn(1, 24)).apply()

    /** The destination folder's name, so the card can show it without a lookup. */
    var folderName: String
        get() = prefs.getString(KEY_FOLDER_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FOLDER_NAME, value).apply()

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
     * One run at a time.
     *
     * The periodic job and the "back up now" job are separate unique work
     * names, so WorkManager will happily run both at once. Two runs scan from
     * the same watermark, offer the same photos, and each passes the server's
     * duplicate check before the other has committed — which put two copies of
     * the same file in the drive, 1.2 seconds apart, under the resume key of a
     * single photo on the phone.
     *
     * A timestamp rather than a boolean, so a worker killed mid-run cannot
     * leave the backup locked for ever: the claim simply expires. It is
     * refreshed as each item starts, so a long upload holds it as long as it
     * is making progress and no longer.
     */
    var lockUntil: Long
        get() = prefs.getLong(KEY_LOCK_UNTIL, 0L)
        set(value) = prefs.edit().putLong(KEY_LOCK_UNTIL, value).apply()

    /** True when another run holds the lock right now. */
    fun anotherRunIsActive(): Boolean = lockUntil > System.currentTimeMillis()

    fun holdLock() {
        lockUntil = System.currentTimeMillis() + LOCK_MS
    }

    fun releaseLock() {
        prefs.edit().remove(KEY_LOCK_UNTIL).apply()
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
        const val KEY_ALBUMS = "albums"
        const val KEY_INCLUDE_PHOTOS = "includePhotos"
        const val KEY_INCLUDE_VIDEOS = "includeVideos"
        const val KEY_MAX_FILE_MB = "maxFileSizeMb"
        const val KEY_FOLDER_NAME = "folderName"
        const val KEY_INTERVAL_HOURS = "intervalHours"
        const val KEY_LOCK_UNTIL = "lockUntil"

        /**
         * How long a claim survives without being refreshed.
         *
         * Longer than any single chunk upload can reasonably take, so a slow
         * file is never mistaken for a dead worker, and short enough that a
         * process killed by the system frees the backup within a few minutes.
         */
        const val LOCK_MS = 5 * 60 * 1000L
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
