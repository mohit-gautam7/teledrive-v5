import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { mtprotoConfigured } from "@/lib/telegram-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What a browser needs to upload to Telegram on its own: whether the account
 * has direct upload switched on, and the application's api_id / api_hash.
 *
 * Note what is *not* here. An earlier version of this endpoint also returned
 * the user's stored MTProto session, so the browser could reuse the key the
 * server already had. Telegram does not permit that: an auth key seen on two
 * connections is answered with AUTH_KEY_DUPLICATED and the session is killed,
 * which took the server's own uploads down with it. One key, one client.
 *
 * So the browser authorises itself with its own QR scan and keeps its own
 * session, and the server's credential never leaves the server. The only
 * things that cross here identify the *application*, not the user — but they
 * still sit behind the session cookie rather than in the public bundle,
 * because that is the narrowest place a browser MTProto client can keep them.
 */

/** Credentials must not sit in any cache, shared or private, ever. */
const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache"
} as const;

export async function GET() {
  try {
    const user = await requireUser();
    // Deliberately tight. A browser needs this once per tab; anything hammering
    // it is not an upload.
    rateLimit(`direct-session:${user.id}`, 20, 60_000);

    const config = await prisma.storageConfig.findUnique({
      where: { userId: user.id },
      select: { directUpload: true }
    });

    if (!config?.directUpload) {
      return NextResponse.json(
        { enabled: false, reason: "Direct upload is switched off for this account." },
        { status: 403, headers: NO_STORE }
      );
    }
    if (!mtprotoConfigured()) {
      return NextResponse.json(
        { enabled: false, reason: "This server has no Telegram API credentials configured." },
        { status: 503, headers: NO_STORE }
      );
    }

    return NextResponse.json(
      {
        enabled: true,
        apiId: Number(process.env.API_ID),
        apiHash: String(process.env.API_HASH)
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    return jsonError(error, "Could not read the direct-upload session.");
  }
}

const body = z.object({ enabled: z.boolean() });

/** Turn direct upload on or off for this account. Off takes effect on the next
 *  page load, because a tab that already holds the session keeps it in memory. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    rateLimit(`direct-session-toggle:${user.id}`, 20, 60_000);
    const { enabled } = body.parse(await request.json());

    if (enabled && !mtprotoConfigured()) {
      return NextResponse.json(
        { error: "This server has no Telegram API credentials configured." },
        { status: 503, headers: NO_STORE }
      );
    }

    await prisma.storageConfig.upsert({
      where: { userId: user.id },
      update: { directUpload: enabled },
      create: { userId: user.id, directUpload: enabled }
    });
    return NextResponse.json({ ok: true, enabled }, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error, "Could not change the direct-upload setting.");
  }
}
