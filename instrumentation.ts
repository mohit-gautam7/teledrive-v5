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

  // Stay awake on Render's free plan, from the inside.
  //
  // A free instance is stopped after fifteen minutes without inbound traffic,
  // and the next request waits up to a minute for a cold start - survivable for
  // a page, disruptive mid-upload, which is where the file routes live. The
  // scheduled GitHub workflow pings from outside, but GitHub's scheduler is
  // best-effort and routinely runs late enough to miss the window. A request to
  // this instance's own public URL goes out and comes back in through Render's
  // router like any other, so it counts as traffic and the idle timer never
  // gets to fifteen.
  //
  // The two cover different failures: this one cannot wake an instance that is
  // already down, and the workflow cannot guarantee its timing. RENDER_EXTERNAL_URL
  // is set by Render itself, so nothing here runs anywhere else. The health
  // route is used because it also runs `select 1`, which keeps the free
  // database from pausing after a quiet week.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.RENDER_EXTERNAL_URL) {
    const self = process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
    const timer = setInterval(() => {
      void fetch(`${self}/api/health`, { cache: "no-store" }).catch(() => {
        // A failed ping is not worth a log line every ten minutes; the workflow
        // reports from outside if the service is genuinely unreachable.
      });
    }, 10 * 60 * 1000);
    // Never the reason the process stays alive during a shutdown.
    timer.unref?.();
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
