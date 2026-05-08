import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin, setSessionCookie, signSession } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    rateLimit(`bot-login:${request.ip || "local"}`, 10, 60_000);

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

    const response = NextResponse.json({ user });
    setSessionCookie(response, signSession(user));
    return response;
  } catch (error) {
    return jsonError(error, "Bot login failed.");
  }
}
