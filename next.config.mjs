const dev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy.
 *
 * Honest about what it can and cannot do here:
 *
 *  - `script-src` still needs `'unsafe-inline'`. Next inlines its own hydration
 *    bootstrap, and app/layout.tsx inlines the theme/accent script that has to
 *    run before the first paint. Nonces would fix both, but a nonce has to be
 *    minted per request, which means an edge middleware on every route to buy
 *    a directive that is already backed up elsewhere. It is the one weak line.
 *  - Everything that actually contains an XSS is tight: `object-src 'none'`
 *    (no plugin documents), `base-uri 'self'` (no rewriting relative URLs),
 *    `form-action 'self'` (no exfiltrating a form post), and
 *    `frame-ancestors 'none'` (no clickjacking this app into someone's page).
 *  - `connect-src 'self'` matters most: even if script did run, it has nowhere
 *    to send what it read.
 *  - File responses carry their own, much stricter policy — see
 *    lib/file-stream.ts, where user-uploaded bytes are served under
 *    `default-src 'none'; sandbox`.
 *
 * telegram.org is the login widget: a script that replaces itself with an
 * oauth.telegram.org iframe, hence the entries in script-src and frame-src.
 * `img-src https:` is broad because avatars come from whichever Telegram or
 * Google CDN happens to host them, and an image is not a script.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} https://telegram.org`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://oauth.telegram.org https://telegram.org",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here uses a camera, a microphone or a location, so nothing may.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  // Render terminates TLS in front of this, so it is only ever reached over
  // HTTPS in production; sent unconditionally is wrong for a plain-HTTP
  // local run, hence the guard.
  ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }])
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    serverComponentsExternalPackages: ["telegram", "sharp"],
    instrumentationHook: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
