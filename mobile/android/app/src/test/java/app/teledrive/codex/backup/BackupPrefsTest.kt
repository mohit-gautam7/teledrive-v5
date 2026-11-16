package app.teledrive.codex.backup

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.*
import org.junit.Test

class BackupPrefsTest {
    @Test fun accountSwitchRechecksMediaAndClearsTheOldDestination() {
        val prefs = BackupPrefs(memoryPreferences())
        prefs.enabled = true
        prefs.transport = "direct"
        prefs.bindAccount("first-account")
        prefs.folderId = "first-folder"
        prefs.folderName = "Private photos"
        prefs.watermark = 500
        prefs.uploadedTotal = 10
        prefs.beginItem("private.jpg", 1, 3, 100)
        val revision = prefs.sourceRevision

        prefs.bindAccount("second-account")
        assertEquals(0L, prefs.watermark)
        assertEquals(revision + 1, prefs.sourceRevision)
        assertNull(prefs.folderId)
        assertEquals("", prefs.folderName)
        assertEquals("", prefs.currentName)
        assertEquals(0, prefs.uploadedTotal)
        assertTrue(prefs.enabled)
        assertEquals("direct", prefs.transport)
    }

    @Test fun unchangedAccountPreservesProgressAndUpgradeRetainsChosenFolder() {
        val prefs = BackupPrefs(memoryPreferences())
        prefs.folderId = "chosen-folder"
        prefs.watermark = 200
        prefs.bindAccount("account")
        assertEquals("chosen-folder", prefs.folderId)
        assertEquals(0L, prefs.watermark) // old unbound progress must be verified
        prefs.watermark = 300
        val revision = prefs.sourceRevision
        prefs.bindAccount("account")
        assertEquals(300L, prefs.watermark)
        assertEquals(revision, prefs.sourceRevision)
    }

    @Test fun directAndBackgroundRunsCannotTakeOrReleaseEachOthersLock() {
        val storage = memoryPreferences()
        val direct = BackupPrefs(storage)
        val worker = BackupPrefs(storage)
        assertTrue(direct.tryAcquireLock("direct"))
        assertFalse(worker.tryAcquireLock("worker"))
        worker.releaseLock("worker")
        assertFalse(worker.tryAcquireLock("worker"))
        assertTrue(direct.tryAcquireLock("direct"))
        direct.releaseLock("direct")
        assertTrue(worker.tryAcquireLock("worker"))
    }

    /** The Android interface is a fake; all cursor/account/lock code is real. */
    private fun memoryPreferences(): SharedPreferences {
        val values = mutableMapOf<String, Any?>()
        lateinit var editor: SharedPreferences.Editor
        editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
            when {
                method.name.startsWith("put") -> { values[args!![0] as String] = args[1]; editor }
                method.name == "remove" -> { values.remove(args!![0] as String); editor }
                method.name == "clear" -> { values.clear(); editor }
                method.name == "commit" -> true
                method.name == "apply" -> null
                else -> error("Unexpected preference editor call: ${method.name}")
            }
        } as SharedPreferences.Editor
        return Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when {
                method.name == "edit" -> editor
                method.name == "getAll" -> values.toMap()
                method.name == "contains" -> values.containsKey(args!![0] as String)
                method.name.startsWith("get") -> values[args!![0] as String] ?: args[1]
                else -> error("Unexpected preference call: ${method.name}")
            }
        } as SharedPreferences
    }
}
