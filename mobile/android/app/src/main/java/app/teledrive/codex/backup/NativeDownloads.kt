package app.teledrive.codex.backup

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import java.io.File
import java.io.OutputStream
import java.util.UUID

/**
 * Saves a download into the phone's Downloads folder, written piece by piece.
 *
 * The WebView has no download handling of its own: a link or blob download
 * from the page is silently dropped, and its save-file picker exists but cannot
 * open. So the page pulls the bytes (from Telegram directly, or the file
 * server) and hands them here in base64 pieces, which never holds a whole
 * file in memory on either side.
 *
 * Android 10+ writes through MediaStore with IS_PENDING, so a half-written file
 * never appears in the Downloads app and an aborted one is deleted. Older
 * versions write to this app's own Downloads folder, which needs no permission.
 */
class NativeDownloads(private val context: Context) {
    private class Open(val stream: OutputStream, val uri: Uri?, val file: File?, val label: String)

    private val open = mutableMapOf<String, Open>()

    @Synchronized
    fun begin(name: String, mimeType: String): String {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").take(180).ifBlank { "download" }
        val id = UUID.randomUUID().toString()
        open[id] = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safe)
                put(MediaStore.Downloads.MIME_TYPE, mimeType.ifBlank { "application/octet-stream" })
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Could not create the file in Downloads.")
            val stream = context.contentResolver.openOutputStream(uri) ?: error("Could not open the file in Downloads.")
            Open(stream, uri, null, "Downloads/$safe")
        } else {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
            val file = File(dir, safe)
            Open(file.outputStream(), null, file, file.absolutePath)
        }
        return id
    }

    @Synchronized
    fun write(id: String, base64: String) {
        val target = open[id] ?: error("This download is no longer open.")
        target.stream.write(Base64.decode(base64, Base64.DEFAULT))
    }

    @Synchronized
    fun end(id: String): String {
        val target = open.remove(id) ?: error("This download is no longer open.")
        target.stream.close()
        target.uri?.let {
            context.contentResolver.update(it, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        }
        return target.label
    }

    @Synchronized
    fun abort(id: String) {
        val target = open.remove(id) ?: return
        runCatching { target.stream.close() }
        target.uri?.let { runCatching { context.contentResolver.delete(it, null, null) } }
        target.file?.delete()
    }

    @Synchronized
    fun close() = open.keys.toList().forEach(::abort)
}
