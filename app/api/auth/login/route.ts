import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin, setSessionCookie, signSession, verifyTelegramAuth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    rateLimit(`login:${request.ip || "local"}`, 15, 60_000);
    const body = await request.json();
    if (!verifyTelegramAuth(body)) {
      return NextResponse.json({ error: "Telegram login verification failed. Check BotFather domain and BOT_TOKEN." }, { status: 401 });
    }

    const name = [body.first_name, body.last_name].filter(Boolean).join(" ") || body.username || "Telegram User";
    const user = await prisma.user.upsert({
      where: { telegramId: String(body.id) },
      update: {
        name,
        username: body.username || null,
        avatar: body.photo_url || null
      },
      create: {
        telegramId: String(body.id),
        name,
        username: body.username || null,
        avatar: body.photo_url || null
      }
    });
    const response = NextResponse.json({ user });
    setSessionCookie(response, signSession(user));
    return response;
  } catch (error) {
    return jsonError(error, "Telegram login failed.");
  }
}
