import { env } from "@/lib/env";
import { handleTelegramUpdate, TelegramUpdate } from "@/lib/bot-handler";

/**
 * Local development only — long-polls getUpdates so the bot works without a
 * public webhook URL. Production uses /api/bot/webhook.
 */

let started = false;

export function startBotPolling(): void {
  if (started) return;
  const token = env.BOT_TOKEN;
  if (!token) {
    console.log("[Bot] BOT_TOKEN not set, skipping polling");
    return;
  }
  started = true;

  const base = `https://api.telegram.org/bot${token}`;
  let offset = 0;

  // Remove any webhook so getUpdates works, then poll forever.
  void (async () => {
    try {
      await fetch(`${base}/deleteWebhook`);
    } catch { /* offline dev — poll loop will log */ }

    console.log("[Bot] Polling started (dev mode)");
    for (;;) {
      try {
        const res = await fetch(`${base}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message"]`, {
          signal: AbortSignal.timeout(35_000)
        });
        const body = (await res.json()) as { ok: boolean; result?: Array<TelegramUpdate & { update_id: number }> };
        if (body.ok && body.result) {
          for (const update of body.result) {
            offset = update.update_id + 1;
            try {
              await handleTelegramUpdate(update);
            } catch (err) {
              console.error("[Bot] update failed:", err);
            }
          }
        }
      } catch (err) {
        console.error("[Bot] polling error:", (err as Error).message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();
}
