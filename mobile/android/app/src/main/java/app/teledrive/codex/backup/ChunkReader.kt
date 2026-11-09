package app.teledrive.codex.backup

import java.io.InputStream

/**
 * Cut a stream into fixed-size chunks without trusting read() to be generous.
 *
 * `InputStream.read(buf, off, len)` may return fewer bytes than asked for at
 * any moment and for any reason — a short network read, a content provider
 * handing over one buffer at a time, a file on slow storage. It only means
 * end-of-stream when it returns -1.
 *
 * Treating a short read as "this chunk is done" is the classic chunked-upload
 * bug, and it is nasty because it is invisible: every chunk gets accepted, the
 * upload reports success, and the file is reassembled on the server with holes
 * in it. Nothing fails until someone opens the photo months later.
 *
 * So every chunk but the last is filled completely, and the last is whatever
 * remains. Its own file with its own test because it is pure, it is the one
 * piece here that can corrupt data silently, and a server is not needed to
 * prove it works.
 */
object ChunkReader {

    /**
     * Fill [buffer] from [stream], returning how many bytes were actually read.
     *
     * A return value shorter than the buffer means the stream ended. Zero means
     * it had already ended.
     */
    fun readFully(stream: InputStream, buffer: ByteArray): Int {
        var filled = 0
        while (filled < buffer.size) {
            val read = stream.read(buffer, filled, buffer.size - filled)
            if (read < 0) break
            // read() returning 0 on a blocking stream would spin forever; it is
            // not supposed to happen, but a misbehaving provider should hang the
            // loop no more than a short read should truncate the file.
            if (read == 0) break
            filled += read
        }
        return filled
    }

    /**
     * How many chunks a file of [size] bytes becomes at [chunkSize].
     *
     * Must agree with the server's own arithmetic (`Math.ceil(size / chunk)`),
     * because the server allocates that many slots and refuses an index past
     * the end. A zero-byte file is zero chunks, which the scanner already
     * excludes — it is defined here so the function is total.
     */
    fun chunkCount(size: Long, chunkSize: Int): Int {
        if (size <= 0L || chunkSize <= 0) return 0
        return ((size + chunkSize - 1) / chunkSize).toInt()
    }
}
