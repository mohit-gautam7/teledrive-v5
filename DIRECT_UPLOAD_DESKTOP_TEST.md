# Desktop direct-upload verification — 11 November 2026

## Follow-up after changing Wi-Fi

The test completed successfully on the user's new Wi-Fi. Render health returned
HTTP 200. Retrying reused the saved Telegram receipt: setup sent 213 bytes of
JSON, confirmation sent 19 bytes, and confirmation returned HTTP 200. No file
contents were resent. The test file appeared in the drive and left the pending
queue. The previous failure was network-dependent reachability from this PC;
the precise router/ISP/filtering cause has not been established. Download hash
verification and large-file/overnight testing were not performed.

Public site: https://teledrive-codex.vercel.app

## Result

Direct file transfer to Telegram passed. Full drive confirmation is blocked by
this PC's connection timing out to the Render file server.

- Synthetic test only: `teledrive-desktop-direct-1111.bin`, 98,317 bytes.
- Source SHA-256: `00CB184A64C4E6AA569B215E3A3B5C489709F3B6B971D88FE8F1E70613F05D97`.
- Observed Telegram socket: `wss://flora.web.telegram.org/apiws`.
- Six outgoing Telegram frames, approximately 99,576 wire bytes including protocol overhead.
- Zero file-content relay requests (`/api/upload` or `/api/upload/chunk/...`).
- Primary website setup: HTTP 200, 213-byte JSON request.
- Telegram upload returned a message ID; the subsequent confirmation request was 19 bytes.
- Render confirmation failed with `net::ERR_CONNECTION_TIMED_OUT`, not a CORS rejection.
- Independent GitHub keep-warm check reached Render: HTTP 200; database and bot healthy.

The test remains in the browser queue with its Telegram receipt retained. Retry
after changing this PC to a connection that can reach the Render file server;
confirmation retries reuse the receipt rather than sending the file again.
No completed-file or download-integrity claim is made for this test.

## Fix shipped

PR https://github.com/mohit-gautam7/teledrive-v5/pull/50, production commit
`2a919b2d6988c7271eefb54d5fb71f03c632614b`: direct-only initialization now
uses the primary website's metadata endpoint. Relay uploads keep their original
chunk settings and routing. Confirmation remains on the persistent Telegram
session host, avoiding use of its auth key from a second server.

Typecheck, build, direct-only retry/no-relay tests, direct-part checks, and PR CI
passed. Large-file, overnight, and Android background-direct tests were not run.
Android background backup still uses the file server; it is not browser-direct.
