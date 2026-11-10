package app.teledrive.codex.backup

import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.util.Size
import java.io.ByteArrayOutputStream

/**
 * A small WebP of a photo or video, made by the phone.
 *
 * MediaStore already maintains thumbnails for everything in the gallery, and
 * Android decodes formats the server cannot — HEIC above all, which is what
 * this phone's camera writes. Asking for one costs a few milliseconds and no
 * network.
 */
object Thumbnailer {

    /** Long edge of what gets uploaded, matching what the server would make. */
    private const val EDGE = 400

    /** The server refuses thumbnails over 512 KB; stay clear of the line. */
    private const val MAX_BYTES = 480 * 1024

    /**
     * Returns null where no thumbnail can be had — before Android 10, where
     * loadThumbnail does not exist, or for a result too large to be one. The
     * caller treats every failure the same way: the server makes its own
     * later, exactly as it did before this existed.
     */
    fun make(context: Context, item: MediaItem): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null

        val loaded = context.contentResolver.loadThumbnail(item.uri, Size(EDGE, EDGE), null)
        // loadThumbnail downsamples by powers of two, so "400" can come back as
        // anything up to twice that. Scale the long edge down to keep every
        // thumbnail in the drive the same size whichever side made it.
        val longEdge = maxOf(loaded.width, loaded.height)
        val bitmap =
            if (longEdge > EDGE)
                Bitmap.createScaledBitmap(
                    loaded,
                    (loaded.width * EDGE / longEdge).coerceAtLeast(1),
                    (loaded.height * EDGE / longEdge).coerceAtLeast(1),
                    true
                )
            else loaded

        try {
            val out = ByteArrayOutputStream()
            val format =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY
                else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
            if (!bitmap.compress(format, 72, out)) return null
            return out.toByteArray().takeIf { it.isNotEmpty() && it.size <= MAX_BYTES }
        } finally {
            if (bitmap !== loaded) bitmap.recycle()
            loaded.recycle()
        }
    }
}
