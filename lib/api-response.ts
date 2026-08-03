import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { mapMtprotoError } from "@/lib/mtproto-errors";
import { BotApiError } from "@/lib/telegram-bot";

/**
 * Next's own probe during `next build`, not a fault.
 *
 * It reaches every dynamic route handler, so without this exclusion each build
 * printed a handful of `ref=` lines with a full stack — indistinguishable in the
 * host's log from a real 500, and the first thing anyone grepping for a
 * reference would find.
 */
function isBuildTimeProbe(error: unknown) {
  return error instanceof Error && error.message.includes("Dynamic server usage");
}

export function jsonError(error: unknown, fallback = "Something went wrong.") {
  if (error instanceof Response) return error;
  // Without this, server-side failures reach the user as a bare message with no
  // stack anywhere — nothing to debug from in production logs.
  if (error instanceof Error && !isBuildTimeProbe(error)) {
    console.error("[api]", error.stack || error.message);
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message || "Invalid request." }, { status: 400 });
  }
  // Telegram RPC failures carry an actionable meaning; map them before the
  // generic handling turns them into a bare 500.
  const mtproto = mapMtprotoError(error);
  if (mtproto) return NextResponse.json({ error: mtproto.message }, { status: mtproto.status });

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
    // Bot API failures carry Telegram's own status code. Without this they all
    // collapsed into a bare 500, which the chunk uploader reads as "transient"
    // and retries five times per chunk — so a revoked token or a blocked bot
    // produced a slow storm of identical failures and an opaque error.
    // 4xx here is permanent for this chat, so it is reported as such.
    if (error instanceof BotApiError) {
      // Telegram lets a bot *send* a 50 MB document but only *fetch* a 20 MB
      // one, so this is a permanent property of the stored file, not a fault.
      if (/file is too big|20 MB bot download limit/i.test(message)) {
        return NextResponse.json(
          {
            error:
              "Telegram will not let a bot download a file this large. It was stored as a single document by an earlier version of TeleDrive — re-upload it and it will download fine."
          },
          { status: 409 }
        );
      }
      if (error.code === 401) {
        return NextResponse.json(
          { error: "Telegram rejected this server's bot token. The site owner needs to check BOT_TOKEN." },
          { status: 409 }
        );
      }
      if (error.code === 403) {
        const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
        return NextResponse.json(
          {
            error: `Telegram refused to deliver to your chat — ${bot ? `@${bot}` : "the bot"} was blocked or removed. Unblock it, send it a message, then retry.`
          },
          { status: 409 }
        );
      }
      if (error.code === 429) {
        return NextResponse.json({ error: "Telegram is rate limiting this action. Please wait and retry." }, { status: 429 });
      }
      // Telegram's own 5xx (and network failures, which carry code 0) are worth
      // another attempt; 502 keeps the uploader's retry behaviour.
      return NextResponse.json(
        { error: "Telegram storage is unavailable right now. Please retry." },
        { status: error.code >= 500 || error.code === 0 ? 502 : 400 }
      );
    }
    // An unhandled exception's message is for the logs, not the user — it can
    // carry table names, paths or connection details. The caller's fallback is
    // written for humans; the real message was logged above.
    return serverFailure(error, fallback);
  }
  return serverFailure(error, fallback);
}

/**
 * A 500 the user can actually report.
 *
 * "The server had a problem" is untraceable: the real cause is in the host's
 * log, but nothing connects the two. Every 500 now carries a short reference
 * that is printed beside the stack, so a screenshot of the toast is enough to
 * find the exact failure in Render's logs. The reference is random and carries
 * no information by itself, so it leaks nothing.
 */
function serverFailure(error: unknown, fallback: string) {
  const ref = Math.random().toString(16).slice(2, 10);
  // The build-time probe is not a failure and must not mint a reference: a log
  // full of build refs is exactly what makes a real one hard to find.
  if (!isBuildTimeProbe(error)) {
    console.error(`[api] ref=${ref}`, error instanceof Error ? error.stack || error.message : error);
  }
  return NextResponse.json({ error: fallback, ref }, { status: 500 });
}
