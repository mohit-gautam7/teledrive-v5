package app.teledrive.codex.backup

import org.junit.Assert.*
import org.junit.Test

class MediaCursorTest {
    @Test fun aSecondFileInTheSameSecondIsNotSkipped() {
        val processed = setOf("first")
        assertFalse(MediaScanner.isPending(100, 100, "first", processed))
        assertTrue(MediaScanner.isPending(100, 100, "second", processed))
        assertTrue(MediaScanner.isPending(101, 100, "first", processed))
        assertFalse(MediaScanner.isPending(99, 100, "second", processed))
    }
}
