import { readFileSync } from "node:fs";

const dev = process.env.NODE_ENV !== "production";

/**
 * What is actually running, baked in at build time.
 *
 * The version comes from package.json so there is one place to bump, and the
 * build time is stamped here rather than read from a git SHA because .dockerignore
 * excludes .git — on Render the build has no repository to ask. Together they
 * answer the only question that matters after a deploy: is the thing I just
 * pushed the thing that is now live?
 *
 * The timestamp is pre-formatted as UTC rather than left as an ISO string for the
 * browser to format, because `toLocaleString` disagrees between the server render
 * and the client and React would call that a hydration error.
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const builtAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

/**
 * The second origin that serves file bytes, when the app is split across two.
 *
 * Normalised once, here, because it has to agree in three places that are easy
 * to let drift: the CSP below, the value inlined into the browser bundle, and
 * lib/file-origin. A trailing slash in the dashboard would otherwise produce a
 * CSP entry that matches nothing and a URL with a double slash.
 */
const fileOrigin = (process.env.NEXT_PUBLIC_FILE_ORIGIN || "").trim().replace(/\/+$/, "");
const withFileOrigin = value => (fileOrigin ? `${value} ${fileOrigin}` : value);

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
  withFileOrigin("media-src 'self' blob:"),
  "font-src 'self' data:",
  // The file origin is added only when there is one. Without it, every upload
  // chunk and every streamed download to that host is blocked by the CSP — and
  // blocked silently, which is the worst way to discover a misconfigured split.
  withFileOrigin("connect-src 'self'"),
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
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_TIME: builtAt,
    // Inlined normalised, so the bundle and the CSP cannot disagree about it.
    NEXT_PUBLIC_FILE_ORIGIN: fileOrigin
  },
  experimental: {
    serverComponentsExternalPackages: ["telegram", "sharp"],
    instrumentationHook: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
