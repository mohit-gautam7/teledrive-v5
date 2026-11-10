package app.teledrive.codex.backup

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore

/** A device album: a folder MediaStore holds photos or videos in. */
data class Album(val path: String, val name: String, val photos: Int, val videos: Int)

/** One item from the camera roll, as much as MediaStore will tell us up front. */
data class MediaItem(
    val uri: Uri,
    val name: String,
    val size: Long,
    val mimeType: String,
    /** DATE_ADDED, in seconds since the epoch. Drives the watermark. */
    val addedAt: Long,
    val relativePath: String
)

/**
 * Finds photos and videos the backup has not dealt with yet.
 *
 * MediaStore is Android's index of every image and video on the device. Asking
 * it is the whole reason a native app can do this and a web page cannot: the
 * browser's directory picker needs a human to choose a folder and grant access,
 * and it cannot look again once the tab is closed.
 *
 * The query is deliberately narrow — "added after the watermark, oldest first".
 * Oldest first matters: a run that is killed halfway must leave a watermark that
 * is still true, and that only works if items are processed in watermark order.
 */
class MediaScanner(private val context: Context) {

    /**
     * Where a camera writes, used when the user has not chosen albums yet.
     *
     * Anything else — Screenshots, WhatsApp, Downloads, Telegram's own cache —
     * is usually somebody else's copy of a file, and backing all of it up by
     * default would silently multiply a user's storage. So the default stays
     * narrow and the choice is theirs to widen.
     */
    private val cameraPaths = listOf("DCIM/")

    fun scan(prefs: BackupPrefs, limit: Int): List<MediaItem> {
        val cap = limit.coerceIn(1, MAX_SCAN)
        val since = prefs.watermark
        val chosen = prefs.albums
        val maxBytes = prefs.maxFileSizeMb.toLong() * 1024L * 1024L

        val inAlbum: (String) -> Boolean = { path ->
            if (chosen.isEmpty()) cameraPaths.any { path.startsWith(it, ignoreCase = true) }
            else chosen.any { path.equals(it, ignoreCase = true) }
        }
        // A size cap means "do not back this up", so the item is dropped here
        // rather than skipped later. The consequence is that raising the cap
        // afterwards does not retrieve what it excluded, because the watermark
        // has moved past it — which is what "Re-check everything" is for, and
        // why the card says so beside the field.
        val withinSize: (Long) -> Boolean = { size -> maxBytes <= 0L || size <= maxBytes }

        val items = ArrayList<MediaItem>()
        // Images and videos live in separate collections; both are queried and
        // the results merged, because a sorted union of two cursors is simpler
        // to reason about than MediaStore.Files with a media-type filter. A
        // type the user has switched off is simply never queried.
        if (prefs.includePhotos) queryInto(items, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, since, cap, inAlbum, withinSize)
        if (prefs.includeVideos) queryInto(items, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, since, cap, inAlbum, withinSize)

        // Oldest first, so a partial run still leaves a correct watermark.
        return items.sortedBy { it.addedAt }.take(cap)
    }

    /**
     * Every album on the device holding photos or videos, with counts.
     *
     * One column, every row: MediaStore answers this quickly even on a phone
     * with forty thousand photos, and it is asked only while the settings card
     * is open. The counts are what make the list usable — "Camera 3,122" and
     * "Screenshots 814" tell you what you are signing up for, where a bare list
     * of folder names does not.
     */
    fun albums(): List<Album> {
        val counts = LinkedHashMap<String, IntArray>()
        countInto(counts, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, 0)
        countInto(counts, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, 1)
        return counts.entries
            .map { (path, c) -> Album(path = path, name = albumName(path), photos = c[0], videos = c[1]) }
            .sortedWith(compareByDescending<Album> { it.photos + it.videos }.thenBy { it.name.lowercase() })
    }

    private fun countInto(into: MutableMap<String, IntArray>, collection: Uri, slot: Int) {
        val column =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.MediaColumns.RELATIVE_PATH
            else MediaStore.MediaColumns.DATA
        val cursor = runCatching {
            context.contentResolver.query(collection, arrayOf(column), null, null, null)
        }.getOrNull() ?: return
        cursor.use {
            val col = it.getColumnIndex(column)
            if (col < 0) return
            var seen = 0
            while (it.moveToNext() && seen < MAX_ALBUM_ROWS) {
                seen++
                val path = normalisePath(it.getString(col).orEmpty())
                if (path.isBlank()) continue
                into.getOrPut(path) { IntArray(2) }[slot]++
            }
        }
    }

    /** "DCIM/Camera/" becomes "Camera" — the last real segment is its name. */
    private fun albumName(path: String): String =
        path.trim('/').substringAfterLast('/').ifBlank { "Internal storage" }

    /**
     * How many are waiting. Counts up to [MAX_SCAN] and stops — the UI says
     * "2000+" rather than walking a 40,000-photo cursor to render one number.
     */
    fun pendingCount(prefs: BackupPrefs): Int = scan(prefs, MAX_SCAN).size

    /**
     * Collect up to [cap] items from one collection that pass both filters.
     *
     * The filters run inside the cursor loop, and the cap counts what passed.
     * They used to run afterwards, on the first hundred rows of the collection
     * whatever album they were in — so on a phone whose oldest hundred images
     * were WhatsApp pictures, the scan found four camera photos, raised the
     * watermark to the last of them, looked at the next hundred rows, found no
     * camera photos among those, and announced "Up to date" with fifteen
     * still waiting. A cap applied before a filter is a cap on the wrong thing.
     */
    private fun queryInto(
        into: MutableList<MediaItem>,
        collection: Uri,
        since: Long,
        cap: Int,
        inAlbum: (String) -> Boolean,
        withinSize: (Long) -> Boolean
    ) {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.DATE_ADDED,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.MediaColumns.RELATIVE_PATH
            else MediaStore.MediaColumns.DATA
        )

        val cursor: Cursor = context.contentResolver.query(
            collection,
            projection,
            "${MediaStore.MediaColumns.DATE_ADDED} > ?",
            arrayOf(since.toString()),
            "${MediaStore.MediaColumns.DATE_ADDED} ASC"
        ) ?: return

        cursor.use {
            val idCol = it.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = it.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val sizeCol = it.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val mimeCol = it.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
            val addedCol = it.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
            val pathCol = it.getColumnIndex(projection[5])

            // Counted per collection: sharing the list's size let a full page
            // of images leave no room for any video at all.
            var taken = 0
            while (it.moveToNext() && taken < cap) {
                val name = it.getString(nameCol) ?: continue
                // The album test comes first because it is free; measuring a
                // file's size can mean opening it.
                val relative = normalisePath(if (pathCol >= 0) it.getString(pathCol).orEmpty() else "")
                if (!inAlbum(relative)) continue
                val uri = Uri.withAppendedPath(collection, it.getLong(idCol).toString())

                // SIZE is NULL more often than the documentation suggests —
                // files restored from a backup, synced in by another app, or
                // pushed onto the device have a row before MediaStore has
                // stat'ed them. Reading that as 0 and skipping it is how a
                // backup silently never saves a whole category of photos, so an
                // unknown size is measured rather than assumed.
                val declared = if (it.isNull(sizeCol)) -1L else it.getLong(sizeCol)
                val size = if (declared > 0L) declared else measure(uri)

                // A genuine zero is a file the camera has created but not
                // finished writing. Uploading it would store an empty file and
                // move the watermark past the real one.
                if (size <= 0L) continue
                if (!withinSize(size)) continue
                taken++

                into.add(
                    MediaItem(
                        uri = uri,
                        name = name,
                        size = size,
                        mimeType = it.getString(mimeCol) ?: "application/octet-stream",
                        addedAt = it.getLong(addedCol),
                        relativePath = relative
                    )
                )
            }
        }
    }

    /**
     * Pre-Q gives an absolute path; normalise it to the same "DCIM/Camera/"
     * shape RELATIVE_PATH uses, so one album filter works on every version.
     */
    private fun normalisePath(raw: String): String {
        if (raw.isBlank()) return ""
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return raw
        return raw.substringAfter("/0/", raw).substringBeforeLast('/') + "/"
    }

    /** The file's real length, or -1 if it cannot be read at all. */
    private fun measure(uri: Uri): Long =
        runCatching {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
        }.getOrNull()?.takeIf { it > 0L } ?: -1L

    private companion object {
        /** Ceiling on one scan, so neither memory nor the UI's count runs away. */
        const val MAX_SCAN = 2000

        /** Ceiling on the album counting pass. One column, but still a cursor. */
        const val MAX_ALBUM_ROWS = 60_000
    }
}
