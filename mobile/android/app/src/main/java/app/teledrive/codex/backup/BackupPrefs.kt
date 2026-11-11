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

    val sourceRevision: Int get() = prefs.getInt("sourceRevision", 0)

    /** Only advance, never retreat: two runs can finish out of order. */
    fun raiseWatermark(seconds: Long) {
        if (seconds > watermark) {
            watermark = seconds
            prefs.edit().remove("processedAtWatermark").apply()
        }
    }

    val processedAtWatermark: Set<String>
        get() = prefs.getStringSet("processedAtWatermark", emptySet())?.toSet() ?: emptySet()

    fun markProcessed(item: MediaItem, expectedRevision: Int = sourceRevision) = synchronized(CURSOR_GATE) {
        if (expectedRevision != sourceRevision) return@synchronized
        raiseWatermark(item.addedAt)
        if (item.addedAt == watermark) prefs.edit()
            .putStringSet("processedAtWatermark", processedAtWatermark + item.uri.toString()).apply()
    }

    fun resetWatermark() = synchronized(CURSOR_GATE) {
        // Files that were set aside sit below the watermark, so this is also
        // the way back for them — and the count starts again from nothing.
        prefs.edit()
            .putInt("sourceRevision", sourceRevision + 1)
            .putLong(KEY_WATERMARK, 0L)
            .remove("processedAtWatermark")
            .remove(KEY_PROBLEM_COUNT)
            .remove(KEY_PROBLEM_NAME)
            .remove(KEY_STRIKE_KEY)
            .remove(KEY_STRIKE_COUNT)
            .apply()
    }

    /** Unmetered networks only. On by default: a camera roll is gigabytes. */
    var wifiOnly: Boolean
        get() = networkMode == "wifi"
        set(value) { networkMode = if (value) "wifi" else "both" }

    var networkMode: String
        get() = prefs.getString("networkMode", null)
            ?: if (prefs.getBoolean(KEY_WIFI_ONLY, true)) "wifi" else "both"
        set(value) {
            require(value in listOf("wifi", "mobile", "both"))
            prefs.edit().putString("networkMode", value).putBoolean(KEY_WIFI_ONLY, value == "wifi").apply()
        }

    fun recordActivity(item: MediaItem, state: String, error: String? = null, accountId: String) {
        val old = runCatching { org.json.JSONArray(prefs.getString("activity", "[]")) }.getOrDefault(org.json.JSONArray())
        val rows = org.json.JSONArray()
        rows.put(org.json.JSONObject().put("uri", item.uri.toString()).put("name", item.name)
            .put("accountId", accountId)
            .put("size", item.size).put("status", state).put("error", error?.take(240))
            .put("time", System.currentTimeMillis()))
        for (i in 0 until old.length()) {
            if (rows.length() >= 200) break
            val row = old.optJSONObject(i) ?: continue
            if (row.optString("uri") != item.uri.toString() || row.optString("accountId") != accountId) rows.put(row)
        }
        prefs.edit().putString("activity", rows.toString()).apply()
    }

    fun activity(accountId: String): org.json.JSONArray {
        val all = runCatching { org.json.JSONArray(prefs.getString("activity", "[]")) }.getOrDefault(org.json.JSONArray())
        val result = org.json.JSONArray()
        for (i in 0 until all.length()) {
            val row = all.optJSONObject(i) ?: continue
            if (accountId.isNotBlank() && row.optString("accountId") == accountId) result.put(row)
        }
        return result
    }

    /**
     * Wait for the charger. Off by default — on a phone that is rarely plugged
     * in, this quietly means "never back up", which looks identical to a bug.
     */
    var chargingOnly: Boolean
        get() = prefs.getBoolean(KEY_CHARGING_ONLY, false)
        set(value) = prefs.edit().putBoolean(KEY_CHARGING_ONLY, value).apply()

    /** Destination folder id, or null to create the default Camera backup folder. */
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
     * refreshed as each chunk lands, so a long upload holds it as long as it
     * is making progress and no longer.
     */
    var lockUntil: Long
        get() = prefs.getLong(KEY_LOCK_UNTIL, 0L)
        set(value) = prefs.edit().putLong(KEY_LOCK_UNTIL, value).apply()

    /**
     * Claim the lock for [me], or learn that a different run has it.
     *
     * The owner matters as much as the expiry. When Android kills the process
     * mid-run, WorkManager restarts the very same work a moment later — and
     * the first version of this lock made that work stand down against its own
     * stale claim and report success, which consumed the chain: seventeen
     * hours of nothing, with six hundred photos still waiting. A run that
     * finds its own id on the lock simply carries on.
     *
     * Synchronised on a process-wide gate so two workers starting in the same
     * instant cannot both read "free" before either writes "taken".
     */
    fun tryAcquireLock(me: String): Boolean = synchronized(LOCK_GATE) {
        val now = System.currentTimeMillis()
        val owner = prefs.getString(KEY_LOCK_OWNER, "") ?: ""
        if (lockUntil > now && owner != me) return false
        prefs.edit().putLong(KEY_LOCK_UNTIL, now + LOCK_MS).putString(KEY_LOCK_OWNER, me).apply()
        true
    }

    /** Push the expiry out. Called per chunk, so a slow file cannot outlive its claim. */
    fun refreshLock(me: String) {
        prefs.edit().putLong(KEY_LOCK_UNTIL, System.currentTimeMillis() + LOCK_MS).putString(KEY_LOCK_OWNER, me).apply()
    }

    /** Release, but only a claim that is actually [me]'s to release. */
    fun releaseLock(me: String) = synchronized(LOCK_GATE) {
        if ((prefs.getString(KEY_LOCK_OWNER, "") ?: "") == me) {
            prefs.edit().remove(KEY_LOCK_UNTIL).remove(KEY_LOCK_OWNER).apply()
        }
    }

    /*
     * One file must not be able to stop the rest.
     *
     * Runs go oldest first and stop at the first failure, which is what keeps
     * the watermark honest — and also means a file that fails the same way
     * every time is first in line every time. Strikes count consecutive
     * failures of the same item across runs; at the limit the worker sets the
     * file aside, says so, and moves on.
     *
     * Only failures that are evidence about the *file* earn a strike. A dead
     * network fails every file equally, and striking for that would quietly
     * discard a camera roll one photo at a time during a long outage.
     */
    fun strike(key: String): Int {
        val count =
            if ((prefs.getString(KEY_STRIKE_KEY, "") ?: "") == key) prefs.getInt(KEY_STRIKE_COUNT, 0) + 1 else 1
        prefs.edit().putString(KEY_STRIKE_KEY, key).putInt(KEY_STRIKE_COUNT, count).apply()
        return count
    }

    fun clearStrikes() {
        prefs.edit().remove(KEY_STRIKE_KEY).remove(KEY_STRIKE_COUNT).apply()
    }

    /** Files set aside after repeated failures, for the card to own up to. */
    val problemCount: Int
        get() = prefs.getInt(KEY_PROBLEM_COUNT, 0)

    val lastProblemName: String
        get() = prefs.getString(KEY_PROBLEM_NAME, "") ?: ""

    fun addProblem(name: String) {
        prefs.edit().putInt(KEY_PROBLEM_COUNT, problemCount + 1).putString(KEY_PROBLEM_NAME, name).apply()
    }

    /**
     * When a run last found the previous one had been cut off mid-file.
     *
     * A run that ends normally clears its progress fields; one whose process
     * was killed cannot. Finding them still set at the start of the next run is
     * direct evidence the system ended the last one — unlike a long gap between
     * runs, which a phone that was simply offline produces too.
     */
    var interruptedAt: Long
        get() = prefs.getLong(KEY_INTERRUPTED_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_INTERRUPTED_AT, value).apply()

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
        const val KEY_LOCK_OWNER = "lockOwner"
        const val KEY_STRIKE_KEY = "strikeKey"
        const val KEY_STRIKE_COUNT = "strikeCount"
        const val KEY_PROBLEM_COUNT = "problemCount"
        const val KEY_PROBLEM_NAME = "problemName"
        const val KEY_INTERRUPTED_AT = "interruptedAt"

        /** Guards check-then-claim on the lock within this process. */
        private val LOCK_GATE = Any()
        private val CURSOR_GATE = Any()

        /** Consecutive failures of one file before it is set aside. */
        const val MAX_STRIKES = 3

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
