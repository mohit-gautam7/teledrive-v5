import { NextRequest, NextResponse } from "next/server";

/**
 * CORS for the file origin.
 *
 * Only the deployment that *receives* cross-origin calls needs this — Render, in
 * the split described in lib/file-origin.ts. It reads CORS_ALLOWED_ORIGINS, a
 * comma-separated allowlist of exact origins (the Vercel URL, plus any preview
 * or custom domain that should be able to reach it). Unset, this is inert: no
 * origin is allowed, nothing is added to any response, and a single-origin
 * deployment behaves exactly as it did before.
 *
 * There is no `Access-Control-Allow-Credentials` here, and that is deliberate.
 * Cross-origin requests to the file origin carry a short-lived bearer token, not
 * the session cookie — so no cookie is ever sent to it, no cookie can be
 * replayed from it, and the wildcard-versus-credentials trap that makes CORS
 * misconfigurations dangerous never arises.
 */

const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(value => value.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    // `range` is what makes video seeking work across the origin; without it the
    // browser drops the header on the preflight and every seek re-downloads.
    "Access-Control-Allow-Headers": "authorization, content-type, range, x-requested-with",
    // A cross-origin response exposes almost nothing by default. The download
    // panel needs the length to draw a percentage, the player needs the range
    // headers to seek, and the save dialog needs the filename.
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges, content-disposition, content-type",
    "Access-Control-Max-Age": "86400"
  };
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowed = origin && ALLOWED.includes(origin.replace(/\/+$/, "")) ? origin : null;

  if (request.method === "OPTIONS") {
    // A preflight from an origin that is not on the list gets a plain refusal
    // rather than a 204 without the headers — same outcome in the browser, but
    // legible in a log.
    const response = new NextResponse(null, { status: allowed ? 204 : 403 });
    if (allowed) for (const [key, value] of Object.entries(corsHeaders(allowed))) response.headers.set(key, value);
    response.headers.set("Vary", "Origin");
    return response;
  }

  const response = NextResponse.next();
  if (allowed) for (const [key, value] of Object.entries(corsHeaders(allowed))) response.headers.set(key, value);
  // Set whether or not the origin was allowed: without it a shared cache can
  // serve one origin's allowed response to another origin that is not.
  response.headers.set("Vary", "Origin");
  return response;
}

/**
 * Only the routes that are actually called cross-origin.
 *
 * Matching all of `/api/*` would work, but middleware runs on every matched
 * request on both deployments — including the Vercel one, where there is no
 * allowlist and nothing to add. Listing the file routes keeps that cost off the
 * hundreds of light JSON calls the app makes. Kept in step with HEAVY in
 * lib/file-origin.ts; `/api/upload/check` is included here even though it is not
 * routed cross-origin, because it costs nothing and a future change that does
 * route it would otherwise fail its preflight for no visible reason.
 */
export const config = {
  matcher: [
    // Listed separately: ":path*" does not match the bare path, and the
    // single-shot small-file upload posts to /api/upload itself.
    "/api/upload",
    "/api/upload/:path*",
    "/api/download/:path*",
    "/api/stream/:path*",
    "/api/preview/:path*",
    "/api/public/:path*"
  ]
};
