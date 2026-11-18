package app.teledrive.codex.backup

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class MtprotoClientTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test
    fun igeMatchesOpenSslVector() {
        val key = hex("000102030405060708090A0B0C0D0E0F")
        val iv = hex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F")
        val cipher = MtprotoClient.ige(ByteArray(32), key, iv, encrypt = true)
        assertArrayEquals(hex("1A8519A6557BE652E9DA8E43DA4EF4453CF456B4CA488AA383C79C98B34797CB"), cipher)
        assertArrayEquals(ByteArray(32), MtprotoClient.ige(cipher, key, iv, encrypt = false))
    }

    @Test
    fun tlBytesArePaddedToFour() {
        assertEquals(4, MtprotoClient.Tl().bytes(ByteArray(3)).done().size)
        assertEquals(8, MtprotoClient.Tl().bytes(ByteArray(4)).done().size)
        val long = MtprotoClient.Tl().bytes(ByteArray(300)).done()
        assertEquals(304, long.size)
        assertArrayEquals(byteArrayOf(-2, 44, 1, 0), long.copyOfRange(0, 4))
    }

    @Test
    fun findsTheSentMessageId() {
        val updates = MtprotoClient.Tl().int(0x74ae4240).int(0x1cb5c415).int(1)
            .int(0x4e90bfd6).int(4242).long(99L).done()
        assertEquals(4242, MtprotoClient.sentMessageId(updates, 99L))
        assertEquals(null, MtprotoClient.sentMessageId(updates, 98L))
    }
}
