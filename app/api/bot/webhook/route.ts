import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate, TelegramUpdate } from "@/lib/bot-handler";
import { timingSafeEqualStr } from "@/lib/crypto";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Only Telegram (holding our secret token) may call this.
  //
  // This used to skip the check entirely when WEBHOOK_SECRET was unset, which
  // made an unset variable a full authentication bypass rather than a missing
  // nicety: handleTelegramUpdate issues a login code for whatever `telegramId`
  // the update body claims, and /api/auth/bot-login turns that code into a
  // session. A forged POST was therefore a login as any user, the owner
  // included. It fails closed now — an unconfigured webhook accepts nothing.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] WEBHOOK_SECRET is not set; refusing every update.");
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!header || !timingSafeEqualStr(header, secret)) {
    return NextResponse.json({ ok: false }, { status: 403 });
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
