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

  // A revoked token takes its webhook with it, so the registration is checked
  // at boot rather than left to whoever remembers /api/bot/setup. Not awaited:
  // one Telegram round trip should not sit in front of the first request.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureWebhook } = await import("./lib/telegram-bot");
    void ensureWebhook();
  }

  // The job worker needs a process that outlives a request, so it is opt-in via
  // JOB_WORKER_ENABLED and stays off on serverless, where it would be started
  // and killed once per invocation.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { jobWorkerEnabled } = await import("./lib/feature-flags");
    if (jobWorkerEnabled()) {
      const { startJobWorker } = await import("./lib/jobs/worker");
      startJobWorker();
    }
  }
}
