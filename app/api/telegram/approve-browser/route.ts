import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, browserApprovalOpen, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { userMtprotoSession } from "@/lib/mtproto-session";
import { approveLoginToken, forgetSession } from "@/lib/telegram-user";
import { mapMtprotoError } from "@/lib/mtproto-errors";

export const runtime = "nodejs";
export const maxDuration = 30;

const body = z.object({ qrUrl: z.string().max(300) });

/**
 * Approve this browser's own Telegram QR login with the account's server
 * session, so connecting the device needs no second scan.
 *
 * Only inside the short window opened by a real Telegram sign-in on this same
 * browser (lib/auth setBrowserApprovalCookie). Without it, a TeleDrive cookie
 * alone could mint a Telegram login for any device, which it must never do.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    rateLimit(`approve-browser:${user.id}`, 10, 60_000);
    if (!(await browserApprovalOpen(user.id))) {
      return NextResponse.json(
        { error: "Automatic connection is only available right after signing in with Telegram. Connect this device under Direct upload." },
        { status: 403 }
      );
    }
    const session = await userMtprotoSession(user.id);
    if (!session) return NextResponse.json({ error: "Your Telegram account is not linked." }, { status: 409 });

    const { qrUrl } = body.parse(await request.json());
    try {
      await approveLoginToken(session, qrUrl);
    } finally {
      // Release the key at once; the file host is the one that keeps using it.
      forgetSession(session);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const mapped = mapMtprotoError(error);
    if (mapped) return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    return jsonError(error, "Could not approve this device.");
  }
}
