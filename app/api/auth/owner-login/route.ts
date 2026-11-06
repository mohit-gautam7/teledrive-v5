import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin, setSessionCookie, signSession } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    rateLimit(`owner-login:${clientIp(request)}`, 5, 60_000);

    const ownerKey = process.env.OWNER_LOGIN_KEY;
    if (!ownerKey) {
      return NextResponse.json({ error: "Owner login is not configured. Set OWNER_LOGIN_KEY in Vercel." }, { status: 404 });
    }

    const body = await request.json();
    const submitted = String(body.key ?? "");

    // Timing-safe comparison to prevent brute-force timing attacks
    const match =
      submitted.length === ownerKey.length &&
      crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(ownerKey));

    if (!match) {
      return NextResponse.json({ error: "Invalid key." }, { status: 401 });
    }

    // Use OWNER_TELEGRAM_ID if set so files are shared with the Telegram login account
    const telegramId = process.env.OWNER_TELEGRAM_ID || "teledrive-owner";

    const user = await prisma.user.upsert({
      where: { telegramId },
      update: { name: "Owner" },
      create: { telegramId, name: "Owner", username: "owner" }
    });

    const response = NextResponse.json({ user });
    setSessionCookie(response, signSession(user));
    return response;
  } catch (error) {
    return jsonError(error, "Owner login failed.");
  }
}
