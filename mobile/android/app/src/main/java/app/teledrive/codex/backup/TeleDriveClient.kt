package app.teledrive.codex.backup

import android.content.Context
import android.util.Log
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
 * The phone itself could not hand over the file's bytes.
 *
 * Deliberately not an IOException. Everything that is one gets treated as "the
 * network had a moment", and a file MediaStore lists but cannot open — deleted
 * a second ago, on an unmounted card, revoked by a permission change — is not
 * the network and will fail identically on every retry. Lumped in with real
 * outages it blocked the whole backup behind itself, because runs go oldest
 * first and it was always first.
 */
class LocalReadException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * The server was reached and answered with a 5xx.
 *
 * Still an IOException, so everything that handles a transient failure keeps
 * working. The subtype exists because "the server keeps erroring on this one
 * file while answering everything else" is evidence about the file, and
 * "nothing could be reached" is not.
 */
class ServerErrorException(message: String) : IOException(message)

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

    // File bytes must never fall back to Vercel when the file server is offline.
    private fun callFileServer(
        origin: String,
        path: String,
        what: String,
        build: (Request.Builder) -> Request.Builder
    ): JSONObject {
        BackupNetwork.requireAllowed(appContext, BackupPrefs(appContext))
        if (!BackupNetwork.fileOriginAllowed(origin)) {
            throw IOException("File server unavailable or not configured. Backup paused to protect Vercel bandwidth.")
        }
        http.newCall(build(fileRequest(origin, path)).build()).execute().use { return ok(it, what) }
    }

    /**
     * A request to the file origin, when the deployment has one.
     *
     * The session cookie cannot be used here: it is httpOnly and SameSite=Lax,
     * so it is scoped to the app's own host and will not travel to a second
     * one. /api/auth/file-token exists for exactly this — a one-hour credential
     * carrying only the user id and a "files" scope, signed with the secret both
     * deployments share, which the server refuses to accept as a session.
     *
     * With no file origin configured this is the ordinary cookie request, so a
     * single-origin deployment behaves exactly as before.
     */
    private fun fileRequest(origin: String, path: String): Request.Builder {
        if (origin.isBlank()) return request(path)
        return Request.Builder()
            .url(origin.trimEnd('/') + path)
            .header("Authorization", "Bearer ${fileToken()}")
            .header("User-Agent", "TeleDrive-Android-Backup/1.0")
    }

    /**
     * Mint a file-scoped token, reused until it is nearly expired.
     *
     * One per hour rather than one per chunk: a 2 GB video is 500 chunks at
     * 4 MB, and minting a token for each would be 500 pointless round trips to
     * the very origin this is trying to take traffic away from.
     */
    @Synchronized
    private fun fileToken(): String {
        val now = System.currentTimeMillis()
        cachedToken?.let { if (now < tokenExpiresAt) return it }
        http.newCall(request("/api/auth/file-token").post(EMPTY).build()).execute().use { response ->
            val token = ok(response, "Could not get a file token").optString("token")
            if (token.isBlank()) throw IOException("The server issued no file token")
            cachedToken = token
            // The server signs it for an hour; stop five minutes early so a
            // long upload cannot have one expire mid-file.
            tokenExpiresAt = now + 55 * 60 * 1000L
            return token
        }
    }

    private var cachedToken: String? = null
    private var tokenExpiresAt: Long = 0L

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
            // 408, 425 and 429 are the 4xx codes that mean "not now" rather than
            // "never". Treating a rate limit as a refusal would step over the
            // file and move the watermark past it - a photo silently left out
            // of the backup because the server was busy for a second.
            if (response.code == 408 || response.code == 425 || response.code == 429) {
                throw IOException("$what: $detail")
            }
            if (response.code in 400..499) throw PermanentUploadException("$what: $detail")
            throw ServerErrorException("$what: $detail")
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

    private data class FolderRow(val id: String, val name: String, val parentId: String?)

    /**
     * The folder every backed-up photo goes into, created once if absent.
     *
     * Without this the backup lands in the drive root and mixes a camera roll
     * into everything else the user keeps there, which is both a mess and
     * impossible to undo once a few hundred files have arrived.
     *
     * [known] is re-checked against the server every run rather than trusted.
     * A folder the user has since deleted makes the server answer 404, which
     * `ok()` classifies as permanent, which makes the worker skip the photo and
     * move the watermark past it — so a deleted folder would silently consume
     * the entire camera roll, one run at a time, and report success. One GET
     * every couple of hours is a cheap price for that not happening.
     */
    data class Destination(val id: String, val name: String)

    fun ensureBackupFolder(known: String?): Destination {
        val rows = listFolders()
        // A folder the user chose themselves wins, and keeps its own name - the
        // point of letting them choose is that it is not called Camera backup.
        if (known != null) rows.firstOrNull { it.id == known }?.let { return Destination(it.id, it.name) }
        // Match by name only at the top level; a folder of the same name nested
        // somewhere of the user's own making is theirs, not ours to write into.
        rows.firstOrNull { it.parentId == null && it.name == BACKUP_FOLDER }
            ?.let { return Destination(it.id, it.name) }
        return Destination(createFolder(BACKUP_FOLDER), BACKUP_FOLDER)
    }

    private fun listFolders(): List<FolderRow> {
        http.newCall(request("/api/folders?flat=1").get().build()).execute().use { response ->
            val array = ok(response, "Could not list folders").optJSONArray("folders") ?: return emptyList()
            return (0 until array.length()).mapNotNull { i ->
                val row = array.optJSONObject(i) ?: return@mapNotNull null
                val id = row.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                FolderRow(id, row.optString("name"), row.optString("parentId").takeIf { it.isNotBlank() && it != "null" })
            }
        }
    }

    private fun createFolder(name: String): String {
        http.newCall(request("/api/folders").post(json(JSONObject().put("name", name))).build())
            .execute().use { response ->
                val folder = ok(response, "Could not create the backup folder").optJSONObject("folder")
                return folder?.optString("id")?.takeIf { it.isNotBlank() }
                    ?: throw IOException("The server created no folder to upload into")
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

    data class Session(
        val fileId: String,
        val totalChunks: Int,
        val chunkSize: Int,
        val received: Set<Int>,
        /** Absolute origin the chunks go to, or "" for this same host. */
        val fileOrigin: String
    )

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
                received = received,
                // Absent on an older deployment, which simply means same-origin.
                fileOrigin = parsed.optString("fileOrigin")
            )
        }
    }

    fun uploadChunk(session: Session, index: Int, bytes: ByteArray, length: Int, name: String) {
        val part = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "chunk",
                name,
                object : RequestBody() {
                    override fun contentType() = "application/octet-stream".toMediaType()
                    override fun contentLength() = length.toLong()
                    override fun writeTo(sink: okio.BufferedSink) {
                        var offset = 0
                        while (offset < length) {
                            BackupNetwork.requireAllowed(appContext, BackupPrefs(appContext))
                            val count = minOf(64 * 1024, length - offset)
                            sink.write(bytes, offset, count)
                            offset += count
                        }
                    }
                }
            )
            .build()
        callFileServer(
            session.fileOrigin,
            "/api/upload/chunk/${session.fileId}/$index",
            "Chunk $index of $name failed"
        ) { it.post(part) }
    }

    fun complete(session: Session, name: String) {
        callFileServer(session.fileOrigin, "/api/upload/complete/${session.fileId}", "Could not finish $name") {
            it.post(EMPTY)
        }
    }

    /** Abandon a session so the server does not keep a half-written row. */
    fun abort(session: Session) {
        runCatching {
            callFileServer(session.fileOrigin, "/api/upload/abort/${session.fileId}", "Could not abandon the upload") {
                it.delete()
            }
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
                    BackupNetwork.requireAllowed(appContext, BackupPrefs(appContext))
                    val read = try {
                        ChunkReader.readFully(input, buffer)
                    } catch (unreadable: IOException) {
                        throw LocalReadException("${item.name} could not be read from the phone", unreadable)
                    }
                    if (read <= 0) break
                    if (!session.received.contains(index)) {
                        uploadChunk(session, index, buffer, read, item.name)
                    }
                    sent += read
                    onProgress(sent)
                    index++
                }
            }
            complete(session, item.name)
        } catch (permanent: PermanentUploadException) {
            abort(session)
            throw permanent
        }
        // Anything else propagates untouched and the session is left alone, so
        // the next run resumes it from the chunks the server already holds.

        // The file is stored; the thumbnail is a courtesy. Nothing about it is
        // allowed to turn a finished upload into a failed one.
        runCatching { Thumbnailer.make(appContext, item)?.let { uploadThumb(session, it) } }
            .onFailure { Log.i(TAG, "no thumbnail for ${item.name}: ${it.message}") }
    }

    /**
     * Hand the server a thumbnail made on the phone.
     *
     * The server builds thumbnails lazily by downloading the original back out
     * of Telegram and resizing it — megabytes of transfer per photo, on first
     * view — and it cannot do even that for HEIC, because its image library has
     * no HEVC decoder. The phone has both problems solved already: MediaStore
     * keeps a thumbnail of every photo and video, and Android decodes HEIC
     * natively. Thirty kilobytes sent now replaces all of it.
     */
    private fun uploadThumb(session: Session, webp: ByteArray) {
        val part = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("thumb", "thumb.webp", webp.toRequestBody("image/webp".toMediaType()))
            .build()
        callFileServer(session.fileOrigin, "/api/upload/thumb/${session.fileId}", "Thumbnail upload failed") {
            it.post(part)
        }
    }

    /**
     * Open the item for reading, or say plainly that the phone could not.
     *
     * openInputStream reports a missing file by throwing FileNotFoundException
     * — an IOException — and a revoked permission by throwing
     * SecurityException. Neither is a network failure, and both are stable:
     * the same file fails the same way next run.
     */
    private fun openStream(item: MediaItem): InputStream =
        try {
            appContext.contentResolver.openInputStream(item.uri)
        } catch (unreadable: Exception) {
            throw LocalReadException("${item.name} could not be opened on the phone", unreadable)
        } ?: throw LocalReadException("${item.name} could not be opened on the phone")

    private companion object {
        const val TAG = "TeleDriveBackup"
        const val AUTH_COOKIE = "teledrive_session"
        /** Where the camera roll lands, instead of all over the drive root. */
        const val BACKUP_FOLDER = "Camera backup"
        val EMPTY: RequestBody = ByteArray(0).toRequestBody(null, 0, 0)
    }
}
