import { NextRequest, NextResponse } from "next/server";
import { getMe, setWebhook } from "@/lib/telegram-bot";
import { jsonError } from "@/lib/api-response";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { timingSafeEqualStr } from "@/lib/crypto";

export const runtime = "nodejs";

/**
 * One-time webhook registration. Visit after each deployment (or domain change):
 *   /api/bot/setup?key=<WEBHOOK_SECRET>
 * Registers <NEXT_PUBLIC_APP_URL>/api/bot/webhook with Telegram.
 */
export async function GET(request: NextRequest) {
  try {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      return NextResponse.json({ error: "Set WEBHOOK_SECRET in the environment first." }, { status: 503 });
    }
    // Rate limited because this endpoint is an oracle for WEBHOOK_SECRET, and
    // that secret is the only thing standing in front of /api/bot/webhook.
    rateLimit(`bot-setup:${clientIp(request)}`, 5, 60_000);
    rateLimit("bot-setup:global", 30, 60_000);

    // The header is preferred: a query string lands in access logs, browser
    // history and any Referer sent from the resulting page. The query parameter
    // still works because docs/RENDER.md tells people to visit a URL, but it is
    // no longer the only way to present the key.
    const key =
      request.headers.get("x-webhook-secret") ?? new URL(request.url).searchParams.get("key") ?? "";
    if (!timingSafeEqualStr(key, secret)) {
      return NextResponse.json({ error: "Invalid key." }, { status: 403 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get("host")}`;
    const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/bot/webhook`;

    const [me] = await Promise.all([getMe(), setWebhook(webhookUrl, secret)]);

    return NextResponse.json({
      ok: true,
      bot: `@${me.username}`,
      webhook: webhookUrl,
      message: "Webhook registered. Message the bot to get a login code."
    });
  } catch (error) {
    return jsonError(error, "Webhook setup failed.");
  }
}
