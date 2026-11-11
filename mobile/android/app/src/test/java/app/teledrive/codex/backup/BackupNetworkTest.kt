package app.teledrive.codex.backup

import org.junit.Assert.*
import org.junit.Test

class BackupNetworkTest {
    @Test fun wifiMeansWifiNotMerelyUnmetered() {
        assertTrue(BackupNetwork.allows("wifi", "wifi"))
        assertFalse(BackupNetwork.allows("wifi", "mobile"))
        assertFalse(BackupNetwork.allows("wifi", "other"))
    }
    @Test fun mobileMeansMobileNotMeteredWifi() {
        assertTrue(BackupNetwork.allows("mobile", "mobile"))
        assertFalse(BackupNetwork.allows("mobile", "wifi"))
        assertFalse(BackupNetwork.allows("mobile", "other"))
    }
    @Test fun bothStillRequiresAConnection() {
        assertTrue(BackupNetwork.allows("both", "wifi"))
        assertTrue(BackupNetwork.allows("both", "mobile"))
        assertTrue(BackupNetwork.allows("both", "other"))
        assertFalse(BackupNetwork.allows("both", "offline"))
        assertFalse(BackupNetwork.allows("off", "wifi"))
    }
    @Test fun fileTrafficCannotFallbackToVercel() {
        assertTrue(BackupNetwork.fileOriginAllowed("https://teledrive-v5.onrender.com"))
        for (origin in listOf("", "http://teledrive-v5.onrender.com", "https://teledrive-codex.vercel.app", "https://example.com/path", "https://user:password@example.com")) {
            assertFalse(origin, BackupNetwork.fileOriginAllowed(origin))
        }
    }
}
