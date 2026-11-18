package app.teledrive.codex.backup

import android.content.Context
import android.util.Base64
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.zip.GZIPInputStream
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/** Telegram has logged this device's session out; only reconnecting in the app helps. */
class TelegramSessionGone(message: String) : IOException(message)

class TelegramRpcError(val code: Int, val error: String) : IOException("Telegram refused the upload: $error")

/**
 * The device's Telegram session, handed over by the app's page.
 *
 * The page signs this device in to Telegram (GramJS) and keeps the session in
 * its localStorage. The native uploader needs the same key to upload while the
 * app is closed, so the page passes it here. It lives in noBackupFilesDir so
 * Android's cloud backup never copies a Telegram login off the phone.
 */
object TelegramSessionStore {
    private fun file(context: Context) = File(context.applicationContext.noBackupFilesDir, "telegram-session")

    fun save(context: Context, session: String, apiId: Int) {
        if (session.isBlank() || apiId <= 0) return clear(context)
        file(context).writeText("$apiId\n$session")
    }

    fun clear(context: Context) { file(context).delete() }

    fun has(context: Context) = file(context).exists()

    /** (apiId, dcId, authKey), or null when the page has not connected this device. */
    fun load(context: Context): Triple<Int, Int, ByteArray>? {
        val lines = runCatching { file(context).readLines() }.getOrNull() ?: return null
        val apiId = lines.getOrNull(0)?.toIntOrNull() ?: return null
        val session = lines.getOrNull(1)?.takeIf { it.startsWith("1") } ?: return null
        // GramJS StringSession v1: dc(1) addrLen(2, BE) addr port(2) authKey(256).
        val raw = Base64.decode(session.substring(1), Base64.DEFAULT)
        val addressLength = ((raw[1].toInt() and 0xff) shl 8) or (raw[2].toInt() and 0xff)
        val keyAt = 3 + addressLength + 2
        if (raw.size != keyAt + 256) return null
        return Triple(apiId, raw[0].toInt(), raw.copyOfRange(keyAt, keyAt + 256))
    }
}

/**
 * The smallest MTProto 2.0 client that can put a file in Saved Messages.
 *
 * The app's page already uploads straight to Telegram, but a page stops
 * reaching the network soon after the app is minimised, so a closed app could
 * only say "N new to back up". This does the same upload natively, with the
 * page's own session: same phone, same network, a session id of its own.
 *
 * It speaks only what an upload needs: upload.saveFilePart/saveBigFilePart and
 * messages.sendMedia, each wrapped in invokeWithLayer(initConnection(...)), over
 * the "intermediate" TCP transport. Everything else the server sends (updates,
 * acks, pongs) is read and dropped.
 */
class MtprotoClient(private val apiId: Int, dcId: Int, private val authKey: ByteArray) : Closeable {
    private val random = SecureRandom()
    private val authKeyId = sha("SHA-1", authKey).copyOfRange(12, 20)
    private val sessionId = ByteArray(8).also { random.nextBytes(it) }
    private val socket = Socket()
    private val input: DataInputStream
    private val output: BufferedOutputStream
    private var salt = 0L
    private var seq = 0
    private var lastMsgId = 0L
    private var timeOffsetMs = 0L
    private val toAck = mutableListOf<Long>()

    init {
        require(authKey.size == 256) { "Not a Telegram auth key." }
        val host = DC_IPS[dcId] ?: throw IOException("Unknown Telegram data centre $dcId.")
        socket.connect(InetSocketAddress(host, 443), 20_000)
        socket.soTimeout = 90_000
        socket.tcpNoDelay = true
        input = DataInputStream(BufferedInputStream(socket.getInputStream()))
        output = BufferedOutputStream(socket.getOutputStream())
        output.write(byteArrayOf(-18, -18, -18, -18)) // 0xeeeeeeee: intermediate transport
        output.flush()
    }

    override fun close() { runCatching { socket.close() } }

    /* ── Upload ───────────────────────────────────────────────────────────── */

    /** Upload [stream] ([size] bytes) to Saved Messages; returns the message id. */
    fun uploadToSavedMessages(
        stream: InputStream, size: Long, name: String, mimeType: String, caption: String,
        onProgress: (Long) -> Unit
    ): Int {
        val parts = ((size + PART - 1) / PART).toInt()
        require(size > 0 && parts <= 4000) { "$name is empty or past Telegram's 2,000 MiB limit." }
        val big = size > 10L * 1024 * 1024
        val fileId = random.nextLong()
        var part = 0
        while (part < parts) {
            val batch = (part until minOf(parts, part + PARALLEL)).map { index ->
                val bytes = ByteArray(minOf(PART.toLong(), size - index.toLong() * PART).toInt())
                val read = try { ChunkReader.readFully(stream, bytes) } catch (e: IOException) {
                    throw LocalReadException("$name could not be read from the phone", e)
                }
                if (read != bytes.size) throw LocalReadException("$name changed or ended early. It was not marked as backed up.")
                Tl().apply {
                    if (big) int(0xde7b673d.toInt()).long(fileId).int(index).int(parts).bytes(bytes)
                    else int(0xb304a621.toInt()).long(fileId).int(index).bytes(bytes)
                }.done()
            }
            call(batch).forEach { if (it.int(0) != BOOL_TRUE) throw IOException("Telegram did not accept part of $name.") }
            part += batch.size
            onProgress(minOf(size, part.toLong() * PART))
        }

        val randomId = random.nextLong()
        val request = Tl().int(0x7852834e).int(0).int(0x7da07ec9) // messages.sendMedia, flags, inputPeerSelf
            .int(0x037c9330).int(1 shl 4) // inputMediaUploadedDocument, force_file
            .apply {
                if (big) int(0xfa4f0bb5.toInt()).long(fileId).int(parts).string(name)
                else int(0xf52ff27f.toInt()).long(fileId).int(parts).string(name).string("")
            }
            .string(mimeType)
            .int(VECTOR).int(1).int(0x15590068).string(name) // [documentAttributeFilename]
            .string(caption.take(1000)).long(randomId).done()
        return sentMessageId(call(listOf(request))[0], randomId)
            ?: throw IOException("Telegram stored $name but did not say where.")
    }

    /* ── Requests ─────────────────────────────────────────────────────────── */

    /** Send every request, wait for every answer; answers come back in order. */
    @Synchronized
    fun call(requests: List<ByteArray>): List<ByteArray> {
        val answers = arrayOfNulls<ByteArray>(requests.size)
        val pending = HashMap<Long, Int>()
        fun post(index: Int) { pending[send(wrap(requests[index]), true)] = index }
        requests.indices.forEach(::post)
        while (pending.isNotEmpty()) {
            val results = LinkedHashMap<Long, Any>()
            val (msgId, seqNo, body) = receive()
            handle(msgId, seqNo, body, results)
            if (toAck.isNotEmpty()) {
                send(Tl().int(MSGS_ACK).int(VECTOR).int(toAck.size).apply { toAck.forEach { long(it) } }.done(), false)
                toAck.clear()
            }
            for ((requestId, result) in results) {
                val index = pending.remove(requestId) ?: continue
                when (result) {
                    RESEND -> post(index)
                    is ByteArray -> answers[index] = result
                    is TelegramRpcError -> {
                        val wait = Regex("FLOOD_(?:PREMIUM_)?WAIT_(\\d+)").find(result.error)?.groupValues?.get(1)?.toLongOrNull()
                        when {
                            wait != null && wait <= 60 -> { Thread.sleep((wait + 1) * 1000); post(index) }
                            result.code == 401 || "AUTH_KEY" in result.error || "SESSION_REVOKED" in result.error ->
                                throw TelegramSessionGone("Telegram logged this device out (${result.error}). Open TeleDrive to reconnect.")
                            else -> throw result
                        }
                    }
                    is Throwable -> throw result
                }
            }
        }
        return answers.map { it!! }
    }

    /** invokeWithLayer(initConnection(query)) on every request: cheap, and never forgotten on a resend. */
    private fun wrap(query: ByteArray) = Tl().int(0xda9b0d0d.toInt()).int(LAYER)
        .int(0xc1cd5ea9.toInt()).int(0).int(apiId)
        .string("TeleDrive Android").string("Android ${android.os.Build.VERSION.RELEASE ?: ""}").string("1.0")
        .string("en").string("").string("en").raw(query).done()

    private fun handle(msgId: Long, seqNo: Int, body: ByteArray, results: MutableMap<Long, Any>) {
        if (seqNo and 1 == 1) toAck += msgId
        val r = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN)
        when (r.int) {
            MSG_CONTAINER -> repeat(r.int) {
                val id = r.long; val s = r.int; val length = r.int
                val inner = ByteArray(length).also { r.get(it) }
                handle(id, s, inner, results)
            }
            RPC_RESULT -> {
                val requestId = r.long
                results[requestId] = unpack(body.copyOfRange(12, body.size))
            }
            GZIP_PACKED -> handle(msgId, 0, gunzip(tlBytes(r)), results)
            BAD_SERVER_SALT -> {
                val bad = r.long; r.int; r.int
                salt = r.long
                results[bad] = RESEND
            }
            BAD_MSG_NOTIFICATION -> {
                val bad = r.long; r.int
                val code = r.int
                if (code == 16 || code == 17) {
                    // Phone clock off: take Telegram's time from its own message id.
                    timeOffsetMs = (msgId ushr 32) * 1000 - System.currentTimeMillis()
                    results[bad] = RESEND
                } else results[bad] = IOException("Telegram rejected a message (code $code).")
            }
            NEW_SESSION_CREATED -> { r.long; r.long; salt = r.long }
            else -> Unit // acks, pongs, updates
        }
    }

    private fun unpack(result: ByteArray): Any {
        val r = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN)
        return when (r.int) {
            GZIP_PACKED -> unpack(gunzip(tlBytes(r)))
            RPC_ERROR -> TelegramRpcError(r.int, String(tlBytes(r)))
            else -> result
        }
    }

    /* ── Transport and encryption ─────────────────────────────────────────── */

    private fun newMsgId(): Long {
        val now = System.currentTimeMillis() + timeOffsetMs
        var id = ((now / 1000) shl 32) or ((now % 1000) shl 22)
        if (id <= lastMsgId) id = lastMsgId + 4
        lastMsgId = id
        return id
    }

    private fun send(body: ByteArray, contentRelated: Boolean): Long {
        val msgId = newMsgId()
        val seqNo = if (contentRelated) seq++ * 2 + 1 else seq * 2
        var padding = 16 - (32 + body.size) % 16
        if (padding < 12) padding += 16
        val plain = Tl().long(salt).raw(sessionId).long(msgId).int(seqNo).int(body.size).raw(body)
            .raw(ByteArray(padding).also { random.nextBytes(it) }).done()
        val msgKey = sha("SHA-256", authKey.copyOfRange(88, 120), plain).copyOfRange(8, 24)
        val (key, iv) = kdf(authKey, msgKey, 0)
        val packet = authKeyId + msgKey + ige(plain, key, iv, encrypt = true)
        output.write(Tl().int(packet.size).done())
        output.write(packet)
        output.flush()
        return msgId
    }

    private fun receive(): Triple<Long, Int, ByteArray> {
        val length = Integer.reverseBytes(input.readInt())
        if (length == 4) {
            val code = Integer.reverseBytes(input.readInt())
            if (code == -404) throw TelegramSessionGone("Telegram no longer knows this device's session. Open TeleDrive to reconnect.")
            throw IOException("Telegram closed the connection (error $code).")
        }
        if (length < 24 || length > 16 * 1024 * 1024) throw IOException("Telegram sent a malformed packet.")
        val packet = ByteArray(length).also { input.readFully(it) }
        if (!packet.copyOfRange(0, 8).contentEquals(authKeyId)) throw IOException("Telegram answered for a different session.")
        val msgKey = packet.copyOfRange(8, 24)
        val (key, iv) = kdf(authKey, msgKey, 8)
        val plain = ige(packet.copyOfRange(24, length), key, iv, encrypt = false)
        if (!sha("SHA-256", authKey.copyOfRange(96, 128), plain).copyOfRange(8, 24).contentEquals(msgKey)) {
            throw IOException("A Telegram message failed its integrity check.")
        }
        if (!plain.copyOfRange(8, 16).contentEquals(sessionId)) throw IOException("Telegram answered another session.")
        val r = ByteBuffer.wrap(plain, 16, 16).order(ByteOrder.LITTLE_ENDIAN)
        val msgId = r.long; val seqNo = r.int; val size = r.int
        if (size < 0 || size > plain.size - 32) throw IOException("Telegram sent a malformed message.")
        return Triple(msgId, seqNo, plain.copyOfRange(32, 32 + size))
    }

    companion object {
        /** Must match the GramJS layer the page signs in with. */
        const val LAYER = 198
        const val PART = 512 * 1024
        /** Parts in flight at once; 2 MB of memory. */
        const val PARALLEL = 4
        private val DC_IPS = mapOf(
            1 to "149.154.175.53", 2 to "149.154.167.51", 3 to "149.154.175.100",
            4 to "149.154.167.91", 5 to "91.108.56.130"
        )
        private const val VECTOR = 0x1cb5c415
        private const val BOOL_TRUE = 0x997275b5.toInt()
        private const val MSG_CONTAINER = 0x73f1f8dc
        private const val RPC_RESULT = 0xf35c6d01.toInt()
        private const val RPC_ERROR = 0x2144ca19
        private const val GZIP_PACKED = 0x3072cfa1
        private const val BAD_SERVER_SALT = 0xedab447b.toInt()
        private const val BAD_MSG_NOTIFICATION = 0xa7eff811.toInt()
        private const val NEW_SESSION_CREATED = 0x9ec20908.toInt()
        private const val MSGS_ACK = 0x62d6b459
        private const val UPDATE_MESSAGE_ID = 0x4e90bfd6
        private const val UPDATE_SHORT_SENT_MESSAGE = 0x9015e101.toInt()
        private val RESEND = Any()

        fun sha(algorithm: String, vararg parts: ByteArray): ByteArray =
            MessageDigest.getInstance(algorithm).apply { parts.forEach { update(it) } }.digest()

        /** MTProto 2.0 key derivation; x = 0 for messages we send, 8 for ones we receive. */
        fun kdf(authKey: ByteArray, msgKey: ByteArray, x: Int): Pair<ByteArray, ByteArray> {
            val a = sha("SHA-256", msgKey, authKey.copyOfRange(x, x + 36))
            val b = sha("SHA-256", authKey.copyOfRange(40 + x, 76 + x), msgKey)
            val key = a.copyOfRange(0, 8) + b.copyOfRange(8, 24) + a.copyOfRange(24, 32)
            val iv = b.copyOfRange(0, 8) + a.copyOfRange(8, 24) + b.copyOfRange(24, 32)
            return key to iv
        }

        /** AES-256 in IGE mode, which the JDK does not ship. */
        fun ige(data: ByteArray, key: ByteArray, iv: ByteArray, encrypt: Boolean): ByteArray {
            require(data.size % 16 == 0)
            val aes = Cipher.getInstance("AES/ECB/NoPadding")
            aes.init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"))
            var x = iv.copyOfRange(if (encrypt) 0 else 16, if (encrypt) 16 else 32) // xored before the cipher
            var y = iv.copyOfRange(if (encrypt) 16 else 0, if (encrypt) 32 else 16) // xored after it
            val out = ByteArray(data.size)
            val block = ByteArray(16)
            for (at in data.indices step 16) {
                val inBlock = data.copyOfRange(at, at + 16)
                for (i in 0 until 16) block[i] = (inBlock[i].toInt() xor x[i].toInt()).toByte()
                val done = aes.doFinal(block)
                for (i in 0 until 16) out[at + i] = (done[i].toInt() xor y[i].toInt()).toByte()
                x = out.copyOfRange(at, at + 16)
                y = inBlock
            }
            return out
        }

        /** The id Telegram gave the message sent with [randomId]. */
        fun sentMessageId(updates: ByteArray, randomId: Long): Int? {
            val r = ByteBuffer.wrap(updates).order(ByteOrder.LITTLE_ENDIAN)
            if (updates.size >= 12 && r.getInt(0) == UPDATE_SHORT_SENT_MESSAGE) return r.getInt(8)
            var at = 0
            while (at + 16 <= updates.size) {
                if (r.getInt(at) == UPDATE_MESSAGE_ID && r.getLong(at + 8) == randomId) return r.getInt(at + 4)
                at += 4
            }
            return null
        }

        private fun tlBytes(r: ByteBuffer): ByteArray {
            var length = r.get().toInt() and 0xff
            var header = 1
            if (length == 254) {
                length = (r.get().toInt() and 0xff) or ((r.get().toInt() and 0xff) shl 8) or ((r.get().toInt() and 0xff) shl 16)
                header = 4
            }
            val bytes = ByteArray(length).also { r.get(it) }
            r.position(r.position() + (4 - (header + length) % 4) % 4)
            return bytes
        }

        private fun gunzip(bytes: ByteArray) = GZIPInputStream(ByteArrayInputStream(bytes)).use { it.readBytes() }

        private fun ByteArray.int(at: Int) = ByteBuffer.wrap(this).order(ByteOrder.LITTLE_ENDIAN).getInt(at)
    }

    /** TL serialisation: little-endian ints, length-prefixed padded bytes. */
    class Tl {
        private val out = ByteArrayOutputStream()
        fun int(v: Int) = apply { for (s in 0 until 32 step 8) out.write(v ushr s) }
        fun long(v: Long) = apply { for (s in 0 until 64 step 8) out.write((v ushr s).toInt()) }
        fun raw(b: ByteArray) = apply { out.write(b) }
        fun string(s: String) = bytes(s.toByteArray(Charsets.UTF_8))
        fun bytes(b: ByteArray) = apply {
            val header = if (b.size < 254) { out.write(b.size); 1 } else {
                out.write(254); out.write(b.size); out.write(b.size ushr 8); out.write(b.size ushr 16); 4
            }
            out.write(b)
            repeat((4 - (header + b.size) % 4) % 4) { out.write(0) }
        }
        fun done(): ByteArray = out.toByteArray()
    }
}
