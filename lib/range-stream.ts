/** How much of an MTProto file we pull per read, and how many reads run at
 *  once. One read at a time was round-trip bound (~0.9 MB/s even next to the
 *  DC); a few small windows in flight multiply that and get the first bytes
 *  out sooner, while a stream still holds at most PARALLEL × WINDOW. */
export const MTPROTO_WINDOW = 1024 * 1024;
const MTPROTO_PARALLEL = 4;

/** Pull-based stream over an arbitrary byte range: fixed windows, a few
 *  fetched ahead in parallel, emitted strictly in order. */
export function buildRangeStream(
  rangeStart: number,
  rangeEnd: number,
  read: (start: number, end: number) => Promise<Buffer>
): ReadableStream<Uint8Array> {
  let next = rangeStart;
  const inflight: { start: number; end: number; data: Promise<Buffer> }[] = [];
  const schedule = () => {
    while (inflight.length < MTPROTO_PARALLEL && next <= rangeEnd) {
      const start = next;
      const end = Math.min(start + MTPROTO_WINDOW - 1, rangeEnd);
      const data = read(start, end);
      data.catch(() => {}); // surfaced when this window is consumed
      inflight.push({ start, end, data });
      next = end + 1;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      schedule();
      const w = inflight.shift();
      if (!w) {
        controller.close();
        return;
      }
      try {
        let buf = await w.data;
        // A short read — Telegram returning a partial window near a part
        // boundary — must be filled before moving on. Skipping it used to leave
        // the body shorter than the Content-Length already promised; the
        // browser threw the truncated 206 away and restarted from zero, which
        // was the reload loop.
        while (buf.length < w.end - w.start + 1) {
          const more = await read(w.start + buf.length, w.end);
          if (!more.length) throw new Error(`Upstream returned no data at byte ${w.start + buf.length}.`);
          buf = Buffer.concat([buf, more]);
        }
        controller.enqueue(new Uint8Array(buf));
        schedule();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      inflight.length = 0;
    }
  });
}
