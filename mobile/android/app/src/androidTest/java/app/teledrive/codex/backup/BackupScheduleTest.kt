package app.teledrive.codex.backup

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Does the schedule actually reach the worker, and does the scanner actually
 * see the camera roll?
 *
 * Run: gradlew.bat :app:connectedDebugAndroidTest  (with a device or emulator)
 *
 * These are the two claims the whole feature rests on, and neither can be
 * checked by reading the code. The periodic job is invisible for two hours at a
 * time, so `WorkManagerTestInitHelper` is used to fire it on demand; the scan
 * is answered by the real MediaStore on the device rather than a stub, which is
 * the only version of it that tells the truth — a stub would happily report the
 * sizes that the real MediaStore leaves NULL.
 *
 * Expects photos in DCIM/Camera. Seed an emulator with:
 *   adb push *.png /sdcard/DCIM/Camera/ && adb shell cmd media_scanner scan /sdcard/DCIM/Camera
 */
@RunWith(AndroidJUnit4::class)
class BackupScheduleTest {

    private lateinit var context: Context
    private lateinit var prefs: BackupPrefs

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        prefs = BackupPrefs(context)

        grantMediaPermissionIfAllowed()
        // Not an assertFalse: on a phone where the grant is refused the suite
        // has nothing to say about the scanner, and saying it failed would be a
        // lie about the code. The message names the one manual step instead.
        // GrantPermissionRule used to do this, and had to go: it throws
        // SecurityException on ColorOS / realme UI, which fails all four tests
        // for a reason that has nothing to do with any of them.
        Assume.assumeTrue(
            "Photo access is not granted. This ROM forbids granting it automatically — " +
                "open TeleDrive, switch Automatic backup on, allow photos, then run this again.",
            hasMediaPermission()
        )

        prefs.enabled = true
        prefs.resetWatermark()

        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor { it.run() }.build()
        )
    }

    /**
     * The camera roll is visible, and visible *with a size*.
     *
     * The size is the point. MediaStore leaves SIZE NULL for files it has a row
     * for but has not stat'ed — restored, synced or pushed ones — and reading
     * that as zero silently drops them from every backup, for ever, with no
     * error anywhere. This is the regression test for exactly that.
     */
    @Test
    fun scannerSeesTheCameraRollWithRealSizes() {
        val items = MediaScanner(context).scan(prefs, 50)
        assertTrue("No camera items found — seed DCIM/Camera first.", items.isNotEmpty())
        assertTrue("Every item must have a positive size", items.all { it.size > 0 })
        assertTrue("Every item must be under DCIM/", items.all { it.relativePath.startsWith("DCIM/", true) })

        // Oldest first is what makes a half-finished run resumable: the
        // watermark must never jump past something that was not dealt with.
        val added = items.map { it.addedAt }
        assertEquals("Items must come back oldest first", added.sorted(), added)
    }

    /** The watermark hides what has already been seen, and nothing else. */
    @Test
    fun theWatermarkExcludesWhatIsBehindIt() {
        val scanner = MediaScanner(context)
        val all = scanner.scan(prefs, 50)
        assertTrue("Needs at least two items to test the boundary", all.size >= 2)

        prefs.raiseWatermark(all.first().addedAt)
        val after = scanner.scan(prefs, 50)
        assertTrue("The watermarked item must not come back", after.none { it.uri == all.first().uri })
        assertTrue("Later items must still come back", after.isNotEmpty())
    }

    /**
     * The periodic schedule really runs BackupWorker.
     *
     * Without this the feature could be perfectly written and never fire — the
     * failure mode of every background-work bug report there is.
     */
    @Test
    fun thePeriodicScheduleRunsTheWorker() {
        val before = prefs.lastRunAt
        prefs.lastResult = ""

        BackupScheduler.schedule(context, prefs)

        val manager = WorkManager.getInstance(context)
        val info = manager.getWorkInfosForUniqueWork("teledrive-backup-periodic").get()
        assertEquals("Exactly one periodic job should be registered", 1, info.size)
        assertEquals(WorkInfo.State.ENQUEUED, info[0].state)

        // Stand in for "two hours passed and the constraints were satisfied".
        val driver = WorkManagerTestInitHelper.getTestDriver(context)!!
        driver.setAllConstraintsMet(info[0].id)
        driver.setPeriodDelayMet(info[0].id)

        // The worker records its outcome whatever happens — including the
        // signed-out case, which is what a test device will usually hit.
        val deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(60)
        while (prefs.lastRunAt == before && System.currentTimeMillis() < deadline) {
            Thread.sleep(250)
        }

        assertTrue("The scheduled worker never ran", prefs.lastRunAt > before)
        assertTrue("The worker should record what it did", prefs.lastResult.isNotBlank())
    }

    /* ── Permission plumbing ───────────────────────────────────────────────── */

    private fun mediaPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else listOf(Manifest.permission.READ_EXTERNAL_STORAGE)

    private fun hasMediaPermission(): Boolean = mediaPermissions().all {
        context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Grant the media permissions where the platform allows it.
     *
     * Installing the test APK reinstalls the app, which revokes every runtime
     * permission granted by hand — so on an emulator or CI machine this is what
     * keeps the scanner tests runnable. Vendor ROMs may refuse it outright:
     * realme UI 16 strips GRANT_RUNTIME_PERMISSIONS from the shell uid, so both
     * this and adb's own `pm grant` are denied. A refusal is therefore expected,
     * not exceptional, and the assumption above handles it.
     */
    private fun grantMediaPermissionIfAllowed() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        for (permission in mediaPermissions()) {
            runCatching {
                automation.executeShellCommand("pm grant ${context.packageName} $permission").close()
            }
        }
        // executeShellCommand is asynchronous; the grant lands shortly after.
        val deadline = System.currentTimeMillis() + 2000
        while (!hasMediaPermission() && System.currentTimeMillis() < deadline) Thread.sleep(100)
    }

    /** Switching it off must leave nothing behind to wake the phone up. */
    @Test
    fun cancellingRemovesTheSchedule() {
        BackupScheduler.schedule(context, prefs)
        BackupScheduler.cancel(context)

        val info = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork("teledrive-backup-periodic").get()
        assertTrue("Cancelled work must not stay enqueued", info.all { it.state == WorkInfo.State.CANCELLED })
    }
}
