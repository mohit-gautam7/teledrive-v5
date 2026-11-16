package app.teledrive.codex.backup

import android.content.Context
import android.os.ParcelFileDescriptor
import android.util.Base64
import com.getcapacitor.JSObject
import org.json.JSONArray
import java.io.IOException
import java.util.UUID

/** Bounded MediaStore reads for the visible app's existing Telegram uploader.
 * No Telegram key crosses this bridge and no original bytes go to a web server.
 * A run owns the same lock as WorkManager and only advances after server confirmation.
 */
class DirectBackupSession(private val context: Context) {
    private val prefs = BackupPrefs(context)
    private val client = TeleDriveClient(context, BackupWorker.BASE_URL)
    private var runId: String? = null
    private var account = ""
    private var folder: String? = null
    private var revision = 0
    private val items = linkedMapOf<String, MediaItem>()

    @Synchronized
    fun begin(expectedAccount: String): JSObject {
        check(runId == null) { "A direct backup is already running." }
        require(prefs.enabled && prefs.transport == "direct") { "Choose direct backup and turn backup on first." }
        BackupNetwork.requireAllowed(context, prefs, allowDirect = true)
        val owner = "direct:${UUID.randomUUID()}"
        check(prefs.tryAcquireLock(owner)) { "Another backup is finishing. Try again shortly." }
        runId = owner
        try {
            account = client.whoAmI()
            check(account == expectedAccount) { "Your account changed. Reopen TeleDrive before backing up." }
            prefs.bindAccount(account)
            revision = prefs.sourceRevision
            val destination = client.ensureBackupFolder(prefs.folderId)
            folder = destination.id
            prefs.folderId = destination.id
            prefs.folderName = destination.name
            val pending = MediaScanner(context).scan(prefs, 20)
            val rows = JSONArray()
            pending.forEach { item ->
                val id = UUID.randomUUID().toString()
                items[id] = item
                rows.put(JSObject().put("id", id).put("name", item.name).put("size", item.size)
                    .put("type", item.mimeType).put("lastModified", item.addedAt * 1000))
            }
            prefs.lastResult = if (pending.isEmpty()) "Up to date." else "Direct backup running while the app is open."
            return JSObject().put("runId", owner).put("accountId", account)
                .put("folderId", folder).put("files", rows)
        } catch (error: Exception) {
            end(owner)
            prefs.lastResult = error.message ?: "Direct backup could not start."
            throw error
        }
    }

    private fun requireRun(owner: String) {
        check(owner == runId) { "Direct backup session expired. Start again." }
        check(prefs.transport == "direct" && prefs.enabled) { "Direct backup was switched off." }
        check(prefs.sourceRevision == revision && prefs.folderId == folder) { "Backup settings changed. Start again." }
        BackupNetwork.requireAllowed(context, prefs, allowDirect = true)
        if (prefs.chargingOnly) {
            val battery = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
            check(battery.isCharging) { "Waiting for the charger." }
        }
        check(prefs.tryAcquireLock(owner)) { "Another backup owns the session. Start again." }
    }

    @Synchronized
    fun read(owner: String, id: String, offset: Long, length: Int): JSObject {
        requireRun(owner)
        val item = items[id] ?: error("Unknown backup file.")
        require(offset >= 0 && length in 1..524288 && offset <= item.size - length) { "Invalid backup byte range." }
        val descriptor = context.contentResolver.openFileDescriptor(item.uri, "r")
            ?: throw IOException("The selected photo or video cannot be opened.")
        val bytes = ByteArray(length)
        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
            // MediaStore files are seekable; fail safely if a provider isn't.
            // Never buffer a whole video or repeatedly scan it from byte zero.
            input.channel.position(offset)
            val read = ChunkReader.readFully(input, bytes)
            check(read == length) { "The file changed or ended early. Backup is paused." }
        }
        return JSObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    @Synchronized
    fun acknowledge(owner: String, id: String): JSObject {
        requireRun(owner)
        check(items.keys.firstOrNull() == id) { "Backup files must finish in order." }
        val item = items[id] ?: error("Unknown backup file.")
        check(client.whoAmI() == account) { "Your account changed. Backup is paused." }
        // Check the drive, rather than trusting a success claimed by JavaScript.
        check(client.findExisting(listOf(item), folder).contains(0)) { "The drive has not confirmed this file. Retry to confirm it." }
        requireRun(owner)
        prefs.markProcessed(item, revision)
        prefs.recordActivity(item, "completed", accountId = account)
        prefs.uploadedTotal = prefs.uploadedTotal + 1
        prefs.lastRunAt = System.currentTimeMillis()
        items.remove(id)
        return JSObject().put("ok", true)
    }

    @Synchronized
    fun end(owner: String): JSObject {
        if (owner != runId) return JSObject().put("ok", true)
        prefs.lastResult = if (items.isEmpty()) "Direct backup batch finished." else "Direct backup paused. Open the app and continue."
        prefs.releaseLock(owner)
        items.clear()
        runId = null
        return JSObject().put("ok", true)
    }

    @Synchronized
    fun close() { runId?.let { end(it) } }
}
