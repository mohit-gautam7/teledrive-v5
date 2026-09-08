import { NextResponse } from "next/server";
import { requireUser, signFileToken } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Mint the credential the file origin accepts.
 *
 * Called on the *primary* origin, where the session cookie is, and only when
 * NEXT_PUBLIC_FILE_ORIGIN is set — on a single-origin deployment the client
 * never asks. The token is scoped to file routes and lives an hour; see
 * lib/auth.signFileToken for why it is not simply the session.
 *
 * POST rather than GET so it cannot be triggered by a stray `<img src>` or
 * prefetched by a link scanner, and so it is never cached anywhere.
 */
export async function POST() {
  try {
    const user = await requireUser();
    // Generous — a folder drop of hundreds of files shares one token — but
    // bounded, so a loop cannot mint credentials indefinitely.
    rateLimit(`file-token:${user.id}`, 60, 60_000);

    return NextResponse.json(
      { token: signFileToken(user.id), expiresIn: 3600 },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error, "Could not issue a file token.");
  }
}
