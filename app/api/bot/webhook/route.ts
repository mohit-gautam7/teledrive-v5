import { NextRequest, NextResponse } from "next/server";
import TelegramBot from "node-telegram-bot-api";
import { prisma } from "@/lib/prisma";

function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request: NextRequest) {
  // Validate secret header so only Telegram can call this
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      return NextResponse.json({ ok: false }, { status: 403 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = (body.message ?? body.edited_message) as {
    from?: { id?: number; first_name?: string; last_name?: string; username?: string; language_code?: string };
    chat?: { id?: number };
    text?: string;
  } | undefined;

  if (!message?.from?.id || !message?.chat?.id) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const telegramId = String(message.from.id);
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "User";
  const username = message.from.username ?? null;

  // Generate a fresh 6-digit code, valid for 10 minutes
  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Invalidate any previous unused codes for this user
  await prisma.botLoginCode.updateMany({
    where: { telegramId, used: false },
    data: { used: true }
  });

  await prisma.botLoginCode.create({
    data: { telegramId, name, username, code, expiresAt }
  });

  // Send the code back to the user
  const bot = new TelegramBot(String(process.env.BOT_TOKEN));
  await bot.sendMessage(
    chatId,
    `🔑 *TeleDrive Login Code*\n\n\`${code}\`\n\n_Valid for 10 minutes. Do not share this code._`,
    { parse_mode: "Markdown" }
  );

  return NextResponse.json({ ok: true });
}
