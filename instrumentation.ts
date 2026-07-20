export async function register() {
  // Dev-only bot polling. In production (Vercel) the bot is driven by the
  // /api/bot/webhook route — polling there would conflict with the webhook.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NODE_ENV === "development" &&
    !process.env.VERCEL &&
    process.env.ENABLE_BOT_POLLING !== "0"
  ) {
    const { startBotPolling } = await import("./lib/bot-polling");
    startBotPolling();
  }
}
