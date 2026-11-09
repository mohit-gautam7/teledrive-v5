package app.teledrive.codex.backup

import android.content.Context
import android.webkit.CookieManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

class NotSignedInException : IOException("Not signed in to TeleDrive.")

/** The server refused this file for good — retrying will not help. */
class PermanentUploadException(message: String) : IOException(message)

/**
 * Talks to the TeleDrive upload API the same way the website does.
 *
 * Nothing here is a second implementation of the upload protocol for its own
 * sake — it exists because the website's version runs in a page, and a page
 * does not exist once the app is closed. The endpoints, the chunk size and the
 * order of calls are all the server's, read back from it at runtime rather than
 * assumed, so the day the server raises its chunk size this follows.
 *
 * ── Why the cookie comes from the WebView ──────────────────────────────────
 *
 * The user signs in inside the app's WebView, exactly as they would in a
 * browser, and the server replies with an httpOnly session cookie. httpOnly
 * hides it from JavaScript, not from the app: Android's CookieManager is a
 * native API and can read it. So the background worker borrows the session the
 * user already established instead of storing a second credential of its own.
 *
 * The practical consequence is that backup stops working when the user signs
 * out, which is the correct behaviour and the reason it was done this way.
 */
class TeleDriveClient(context: Context, private val baseUrl: String) {

    private val appContext = context.applicationContext

    private val http = OkHttpClient.Builder()
        // A 4 MB chunk over a weak mobile link is slow but not broken; the
        // default 10s write timeout fails it anyway. Generous, with the real
        // limit enforced by WorkManager's own 10-minute budget per run.
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(180, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private fun sessionCookie(): String {
        val cookies = CookieManager.getInstance().getCookie(baseUrl)
            ?: throw NotSignedInException()
        if (!cookies.contains(AUTH_COOKIE)) throw NotSignedInException()
        return cookies
    }

    private fun request(path: String): Request.Builder =
        Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Cookie", sessionCookie())
            // Named so the server's logs can tell background backup apart from
            // somebody sitting in the app, which matters when diagnosing why a
            // phone stopped uploading.
            .header("User-Agent", "TeleDrive-Android-Backup/1.0")

    private fun json(body: JSONObject): RequestBody =
        body.toString().toRequestBody("application/json".toMediaType())

    /** Throws for anything but 2xx, mapping the server's own message through. */
    private fun ok(response: Response, what: String): JSONObject {
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            val detail = if (message.isNullOrBlank()) "HTTP ${response.code}" else message
            if (response.code == 401 || response.code == 403) throw NotSignedInException()
            // 4xx that is not auth means this file will never be accepted:
            // too large, a duplicate, a folder that is gone. Retrying the same
            // bytes every three hours forever is the failure to avoid here.
            if (response.code in 400..499) throw PermanentUploadException("$what: $detail")
            throw IOException("$what: $detail")
        }
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    /** Confirms the session is real before a run does any work. */
    fun whoAmI(): String {
        http.newCall(request("/api/auth/me").get().build()).execute().use { response ->
            val body = ok(response, "Session check failed")
            return body.optJSONObject("user")?.optString("username").orEmpty()
        }
    }

    /**
     * Ask which of these the drive already holds.
     *
     * Advisory — /api/upload/init checks again — but it turns a backlog of
     * already-stored photos into one request instead of one failed upload each.
     */
    fun findExisting(items: List<MediaItem>, folderId: String?): Set<Int> {
        if (items.isEmpty()) return emptySet()
        val entries = JSONArray()
        items.forEach { item ->
            entries.put(
                JSONObject()
                    .put("name", item.name)
                    .put("size", item.size)
                    .apply { if (folderId != null) put("folderId", folderId) }
            )
        }
        http.newCall(request("/api/upload/check").post(json(JSONObject().put("entries", entries))).build())
            .execute().use { response ->
                val duplicates = ok(response, "Duplicate check failed").optJSONArray("duplicates")
                    ?: return emptySet()
                val found = HashSet<Int>()
                for (i in 0 until duplicates.length()) {
                    found.add(duplicates.getJSONObject(i).optInt("index", -1))
                }
                found.remove(-1)
                return found
            }
    }

    data class Session(val fileId: String, val totalChunks: Int, val chunkSize: Int, val received: Set<Int>)

    fun initUpload(item: MediaItem, folderId: String?): Session {
        val body = JSONObject()
            .put("fileName", item.name)
            .put("mimeType", item.mimeType)
            .put("fileSize", item.size)
            // A stable key per media item, so a half-finished upload is resumed
            // on the next run rather than started again from byte zero.
            .put("resumeKey", "android-backup:${item.uri}")
            .apply { if (folderId != null) put("folderId", folderId) }

        http.newCall(request("/api/upload/init").post(json(body)).build()).execute().use { response ->
            val parsed = ok(response, "Could not start upload of ${item.name}")
            val receivedArray = parsed.optJSONArray("received")
            val received = HashSet<Int>()
            if (receivedArray != null) for (i in 0 until receivedArray.length()) received.add(receivedArray.getInt(i))
            return Session(
                fileId = parsed.getString("fileId"),
                totalChunks = parsed.getInt("totalChunks"),
                chunkSize = parsed.getInt("chunkSizeBytes"),
                received = received
            )
        }
    }

    fun uploadChunk(fileId: String, index: Int, bytes: ByteArray, length: Int, name: String) {
        val part = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "chunk",
                name,
                bytes.toRequestBody("application/octet-stream".toMediaType(), 0, length)
            )
            .build()
        http.newCall(request("/api/upload/chunk/$fileId/$index").post(part).build()).execute().use { response ->
            ok(response, "Chunk $index of $name failed")
        }
    }

    fun complete(fileId: String, name: String) {
        http.newCall(request("/api/upload/complete/$fileId").post(EMPTY).build()).execute().use { response ->
            ok(response, "Could not finish $name")
        }
    }

    /** Abandon a session so the server does not keep a half-written row. */
    fun abort(fileId: String) {
        runCatching {
            http.newCall(request("/api/upload/abort/$fileId").delete().build()).execute().close()
        }
    }

    /**
     * Send one file, chunk by chunk, resuming whatever the server already has.
     *
     * The stream is read straight from MediaStore into a fixed buffer, so a
     * 4 GB video costs one chunk of memory rather than its own size — the
     * mistake that makes naive backup apps die on the first long video.
     */
    fun upload(item: MediaItem, folderId: String?, onProgress: (Long) -> Unit) {
        val session = initUpload(item, folderId)
        val buffer = ByteArray(session.chunkSize)
        var index = 0
        var sent = 0L

        try {
            openStream(item).use { input ->
                while (index < session.totalChunks) {
                    val read = ChunkReader.readFully(input, buffer)
                    if (read <= 0) break
                    if (!session.received.contains(index)) {
                        uploadChunk(session.fileId, index, buffer, read, item.name)
                    }
                    sent += read
                    onProgress(sent)
                    index++
                }
            }
            complete(session.fileId, item.name)
        } catch (permanent: PermanentUploadException) {
            abort(session.fileId)
            throw permanent
        } catch (error: Throwable) {
            // Transient: leave the session alone so the next run resumes it.
            throw error
        }
    }

    private fun openStream(item: MediaItem): InputStream =
        appContext.contentResolver.openInputStream(item.uri)
            ?: throw PermanentUploadException("${item.name} could not be opened — it may have been deleted.")

    private companion object {
        const val AUTH_COOKIE = "teledrive_session"
        val EMPTY: RequestBody = ByteArray(0).toRequestBody(null, 0, 0)
    }
}
