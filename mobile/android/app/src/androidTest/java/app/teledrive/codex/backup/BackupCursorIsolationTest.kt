package app.teledrive.codex.backup

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** Uses an isolated preferences file; never resets the user's real backup state. */
class BackupCursorIsolationTest {
    private lateinit var prefs: BackupPrefs
    private lateinit var storage: SharedPreferences

    @Before fun prepare() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val testName = "backup-cursor-test-" + UUID.randomUUID()
        storage = base.getSharedPreferences(testName, Context.MODE_PRIVATE)
        val isolated = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = storage
        }
        prefs = BackupPrefs(isolated)
    }

    @After fun clean() { storage.edit().clear().commit() }

    private fun item(name: String) = MediaItem(Uri.parse("content://backup-test/$name"), name, 1, "image/jpeg", 100, "DCIM/Test/")

    @Test fun staleWorkerCannotAdvanceAChangedSource() {
        val old = prefs.sourceRevision
        prefs.resetWatermark()
        prefs.markProcessed(item("old"), old)
        assertEquals(0L, prefs.watermark)
        assertTrue(prefs.processedAtWatermark.isEmpty())
        prefs.markProcessed(item("new"), prefs.sourceRevision)
        assertEquals(100L, prefs.watermark)
    }

    @Test fun sameSecondFilesKeepTheirSeparateIdentities() {
        val first = item("one")
        val second = item("two")
        prefs.markProcessed(first)
        assertFalse(MediaScanner.isPending(100, prefs.watermark, first.uri.toString(), prefs.processedAtWatermark))
        assertTrue(MediaScanner.isPending(100, prefs.watermark, second.uri.toString(), prefs.processedAtWatermark))
        prefs.markProcessed(second)
        assertEquals(2, prefs.processedAtWatermark.size)
    }

    @Test fun historyIsSeparatedByAccount() {
        prefs.recordActivity(item("alice-photo"), "completed", accountId = "alice")
        prefs.recordActivity(item("bob-photo"), "failed", "test failure", "bob")
        assertEquals(1, prefs.activity("alice").length())
        assertEquals("alice-photo", prefs.activity("alice").getJSONObject(0).getString("name"))
        assertEquals(0, prefs.activity("other").length())
        assertEquals(0, prefs.activity("").length())
    }
}
