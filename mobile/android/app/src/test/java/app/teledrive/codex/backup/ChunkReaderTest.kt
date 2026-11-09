package app.teledrive.codex.backup

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * The upload's one silent-corruption risk, pinned down.
 *
 * Run: gradlew.bat :app:testDebugUnitTest
 *
 * These tests exist because the bug they prevent cannot be noticed by hand.
 * A truncating chunker produces an upload that succeeds, a file that is the
 * right size on the server, and a photo that will not open — discovered, if
 * ever, long after the original is gone from the phone.
 */
class ChunkReaderTest {

    /** Hands back one byte at a time, the worst legal behaviour for read(). */
    private class DribblingStream(data: ByteArray) : InputStream() {
        private val inner = ByteArrayInputStream(data)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            val one = inner.read()
            if (one < 0) return -1
            b[off] = one.toByte()
            return 1
        }
    }

    /** Returns at most 7 bytes per call — a realistic awkward number. */
    private class ChoppyStream(data: ByteArray) : InputStream() {
        private val inner = ByteArrayInputStream(data)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int =
            inner.read(b, off, minOf(len, 7))
    }

    private fun bytes(n: Int) = ByteArray(n) { (it % 251).toByte() }

    @Test
    fun `a full chunk is filled even when the stream dribbles one byte at a time`() {
        val data = bytes(1000)
        val buffer = ByteArray(1000)
        val read = ChunkReader.readFully(DribblingStream(data), buffer)
        // The whole point: one short read must not end the chunk.
        assertEquals(1000, read)
        assertArrayEquals(data, buffer)
    }

    @Test
    fun `chunks come out contiguous and in order from an awkward stream`() {
        val data = bytes(10_000)
        val chunkSize = 1024
        val stream = ChoppyStream(data)
        val rebuilt = ArrayList<Byte>(data.size)
        val buffer = ByteArray(chunkSize)

        var chunks = 0
        while (true) {
            val read = ChunkReader.readFully(stream, buffer)
            if (read <= 0) break
            chunks++
            // Every chunk but the last must be exactly full, or the server's
            // offsets stop lining up with the client's.
            if (rebuilt.size + read < data.size) assertEquals(chunkSize, read)
            for (i in 0 until read) rebuilt.add(buffer[i])
        }

        assertArrayEquals(data, rebuilt.toByteArray())
        assertEquals(ChunkReader.chunkCount(data.size.toLong(), chunkSize), chunks)
    }

    @Test
    fun `the final short chunk reports its real length`() {
        val data = bytes(1500)
        val buffer = ByteArray(1024)
        val stream = ByteArrayInputStream(data)
        assertEquals(1024, ChunkReader.readFully(stream, buffer))
        assertEquals(476, ChunkReader.readFully(stream, buffer))
        assertEquals(0, ChunkReader.readFully(stream, buffer))
    }

    @Test
    fun `an exhausted stream reads zero rather than looping`() {
        assertEquals(0, ChunkReader.readFully(ByteArrayInputStream(ByteArray(0)), ByteArray(64)))
    }

    @Test
    fun `chunk count matches the server's ceiling division`() {
        val chunk = 4 * 1024 * 1024
        // Exact multiples must not gain a phantom empty chunk: the server would
        // wait forever for a chunk the client never sends.
        assertEquals(1, ChunkReader.chunkCount(chunk.toLong(), chunk))
        assertEquals(2, ChunkReader.chunkCount(chunk.toLong() + 1, chunk))
        assertEquals(1, ChunkReader.chunkCount(1, chunk))
        assertEquals(0, ChunkReader.chunkCount(0, chunk))
        // A 1.28 GB video — the size of the largest file already in the drive.
        assertEquals(307, ChunkReader.chunkCount(1_284_630_004L, chunk))
    }
}
