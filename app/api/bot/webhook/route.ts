import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate, TelegramUpdate } from "@/lib/bot-handler";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Only Telegram (holding our secret token) may call this.
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      return NextResponse.json({ ok: false }, { status: 403 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleTelegramUpdate(update);
  } catch (err) {
    // Always 200 — otherwise Telegram retries the same update in a loop.
    console.error("[webhook] update failed:", err);
  }
  return NextResponse.json({ ok: true });
}
