import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function jsonError(error: unknown, fallback = "Something went wrong.") {
  if (error instanceof Response) return error;
  // Without this, server-side failures reach the user as a bare message with no
  // stack anywhere — nothing to debug from in production logs. Next's own
  // "Dynamic server usage" probe during `next build` is expected, not a fault.
  if (error instanceof Error && !error.message.includes("Dynamic server usage")) {
    console.error("[api]", error.stack || error.message);
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message || "Invalid request." }, { status: 400 });
  }
  if (error instanceof Error) {
    const message = error.message;
    // Signing in via the widget or Google doesn't open a chat with the bot, and
    // a bot cannot message first — storage fails until the user says hello once.
    if (message.includes("chat not found") || message.includes("bot can't initiate conversation")) {
      const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
      return NextResponse.json(
        {
          error: `Open Telegram and send a message to ${bot ? `@${bot}` : "the bot"} once — your files are stored in that chat, and Telegram won't let a bot message you first.`
        },
        { status: 409 }
      );
    }
    if (message.includes("FLOOD_WAIT") || message.includes("Too Many Requests")) {
      return NextResponse.json({ error: "Telegram is rate limiting this action. Please wait and retry." }, { status: 429 });
    }
    if (message.includes("AUTH_KEY_UNREGISTERED")) {
      return NextResponse.json({ error: "Telegram personal session expired. Reconnect Telegram in Settings." }, { status: 401 });
    }
    if (message.includes("entity too large") || message.includes("Request Entity Too Large")) {
      return NextResponse.json({ error: "This upload is too large for the current server limit." }, { status: 413 });
    }
    return NextResponse.json({ error: message || fallback }, { status: 500 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}
