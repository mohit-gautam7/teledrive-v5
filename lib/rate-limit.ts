/**
 * A fixed-window counter, per key, in this process's memory.
 *
 * ponytail: single-instance. It is a real limit on one Render service and
 * nothing at all across several — the moment this app is scaled out, the same
 * caller gets one bucket per instance. Move the map to Redis if that day comes;
 * until then a dependency and a network hop per request would buy nothing.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Expired buckets are dead weight — one per address that ever hit a route.
 *  Swept on write rather than on a timer, which needs no process to own it. */
const SWEEP_EVERY = 500;
let writes = 0;

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export function rateLimit(key: string, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  if (++writes % SWEEP_EVERY === 0) sweep(now);

  const current = buckets.get(key);
  if (!current || current.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    // Thrown, not returned: jsonError passes a thrown Response through
    // untouched, so a route gets the ceiling by writing one line.
    throw new Response(JSON.stringify({ error: "Too many requests. Please slow down and try again." }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil((current.resetAt - now) / 1000)))
      }
    });
  }
}

/**
 * The caller's address, for keying the buckets above.
 *
 * Next 15 removed `NextRequest.ip`, which is what every call site used to read.
 * Both hosts this runs on put the client address in front of the chain
 * (`x-real-ip` on Vercel, the leftmost `x-forwarded-for` hop on Render), so the
 * header is the replacement rather than a workaround.
 *
 * ponytail: a client can forge these when nothing trusted sits in front — which
 * buys an attacker a fresh rate-limit bucket, and nothing else. Every header
 * here is used for counting only, never for authorisation. If this ever moves
 * behind an untrusted proxy, pin the hop count instead.
 */
export function clientIp(request: { headers: Headers }) {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "local";
  return "local";
}
