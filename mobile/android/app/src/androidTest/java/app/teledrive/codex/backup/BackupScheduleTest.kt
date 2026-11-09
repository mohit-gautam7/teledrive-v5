package app.teledrive.codex.backup

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.rule.GrantPermissionRule
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

    /**
     * Installing the test APK reinstalls the app, which revokes every runtime
     * permission granted by hand. Without this the scanner tests fail with
     * "no camera items" and look like a scanner bug rather than a missing
     * grant — which is exactly how an hour gets wasted.
     */
    @get:Rule
    val permissions: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            GrantPermissionRule.grant(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else GrantPermissionRule.grant(Manifest.permission.READ_EXTERNAL_STORAGE)

    private lateinit var context: Context
    private lateinit var prefs: BackupPrefs

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        prefs = BackupPrefs(context)
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
