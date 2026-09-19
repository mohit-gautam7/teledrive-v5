import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  assertSameOrigin,
  setSessionCookie,
  signSession,
  readPendingLink,
  clearPendingLinkCookie
} from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    rateLimit(`bot-login:${clientIp(request)}`, 10, 60_000);

    const { code } = await request.json();
    if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Enter the 6-digit code from Telegram." }, { status: 400 });
    }

    const record = await prisma.botLoginCode.findFirst({
      where: { code, used: false, expiresAt: { gt: new Date() } }
    });

    if (!record) {
      return NextResponse.json({ error: "Code is invalid or expired. Message the bot again to get a new one." }, { status: 401 });
    }

    // Mark code as used
    await prisma.botLoginCode.update({ where: { id: record.id }, data: { used: true } });

    // Upsert the user (using data captured when the bot received the message)
    const user = await prisma.user.upsert({
      where: { telegramId: record.telegramId },
      update: { name: record.name, username: record.username },
      create: { telegramId: record.telegramId, name: record.name, username: record.username }
    });

    // If a third-party sign-in is waiting to be attached, this code proves the
    // Telegram account belongs to the same person — link them permanently so
    // next time that provider signs in on its own.
    const pending = await readPendingLink();
    if (pending) {
      await prisma.oAuthAccount.upsert({
        where: { provider_providerId: { provider: pending.provider, providerId: pending.providerId } },
        update: { userId: user.id, email: pending.email ?? null },
        create: {
          userId: user.id,
          provider: pending.provider,
          providerId: pending.providerId,
          email: pending.email ?? null
        }
      });
    }

    const response = NextResponse.json({ user, linked: pending?.provider ?? null });
    setSessionCookie(response, signSession(user));
    if (pending) clearPendingLinkCookie(response);
    return response;
  } catch (error) {
    return jsonError(error, "Bot login failed.");
  }
}
