package app.teledrive.codex.backup

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore

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
     * Where a camera actually writes. Anything else — Screenshots, WhatsApp,
     * Downloads, Telegram's own cache — is somebody else's copy of a file, and
     * backing it up by default would silently triple a user's storage.
     */
    private val cameraPaths = listOf("DCIM/")

    fun scan(prefs: BackupPrefs, limit: Int): List<MediaItem> {
        // Doubled because camera filtering happens after the query, so the
        // raw cursors must over-fetch. coerceAtMost keeps Int.MAX_VALUE from
        // wrapping negative, which silently returned an empty list.
        val rawCap = if (limit >= MAX_SCAN / 2) MAX_SCAN else limit * 2
        val since = prefs.watermark
        val items = ArrayList<MediaItem>()
        // Images and videos live in separate collections; both are queried and
        // the results merged, because a sorted union of two cursors is simpler
        // to reason about than MediaStore.Files with a media-type filter.
        queryInto(items, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, since, rawCap)
        queryInto(items, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, since, rawCap)

        val filtered =
            if (prefs.includeNonCamera) items
            else items.filter { item -> cameraPaths.any { item.relativePath.startsWith(it, ignoreCase = true) } }

        // Oldest first, so a partial run still leaves a correct watermark.
        return filtered.sortedBy { it.addedAt }.take(limit.coerceAtMost(MAX_SCAN))
    }

    /**
     * How many are waiting. Counts up to [MAX_SCAN] and stops — the UI says
     * "2000+" rather than walking a 40,000-photo cursor to render one number.
     */
    fun pendingCount(prefs: BackupPrefs): Int = scan(prefs, MAX_SCAN).size

    private fun queryInto(into: MutableList<MediaItem>, collection: Uri, since: Long, cap: Int) {
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

            while (it.moveToNext() && into.size < cap) {
                val name = it.getString(nameCol) ?: continue
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
                val rawPath = if (pathCol >= 0) it.getString(pathCol).orEmpty() else ""
                // Pre-Q gives an absolute path; normalise it to the same
                // "DCIM/Camera/" shape RELATIVE_PATH uses so one filter works.
                val relative =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) rawPath
                    else rawPath.substringAfter("/0/", rawPath).substringBeforeLast('/') + "/"

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

    /** The file's real length, or -1 if it cannot be read at all. */
    private fun measure(uri: Uri): Long =
        runCatching {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
        }.getOrNull()?.takeIf { it > 0L } ?: -1L

    private companion object {
        /** Ceiling on one scan, so neither memory nor the UI's count runs away. */
        const val MAX_SCAN = 2000
    }
}
