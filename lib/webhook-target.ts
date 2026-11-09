/**
 * Where — and whether — this deployment may register the Telegram webhook.
 *
 * Its own module, importing nothing, for two reasons: the decision is the part
 * worth testing (see scripts/check-webhook-target.mjs), and the guards are the
 * part that can cause real damage if they are wrong.
 *
 * A webhook belongs to the bot, not to a deployment. Whoever registers one
 * takes delivery of every message for the whole bot. So a preview build that
 * healed itself at boot would quietly take production's login flow away, which
 * is worse than the missing registration it set out to fix — and invisible,
 * because the preview would look perfectly healthy.
 */
export type WebhookEnv = {
  /** Vercel sets this on every deployment; absent when self-hosted. */
  VERCEL?: string;
  /** "production" | "preview" | "development" on Vercel. */
  VERCEL_ENV?: string;
  NODE_ENV?: string;
  /** The canonical public origin — never a request's Host header. */
  NEXT_PUBLIC_APP_URL?: string;
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
};

/**
 * The webhook URL this deployment should own, or null to leave it alone.
 *
 * The URL is built from NEXT_PUBLIC_APP_URL rather than the incoming request,
 * so a production deployment reached by its *.vercel.app build URL still
 * registers the real domain instead of a URL that changes every deploy.
 */
export function webhookTarget(env: WebhookEnv): string | null {
  // On Vercel only production may claim it. Self-hosted, any production boot
  // may: there is only ever the one server.
  const allowed = env.VERCEL ? env.VERCEL_ENV === "production" : env.NODE_ENV === "production";
  if (!allowed) return null;
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return null;

  const origin = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  // An http:// or relative value would register a webhook Telegram refuses, so
  // it is treated as "not configured" rather than attempted.
  if (!origin || !origin.startsWith("https://")) return null;

  return `${origin}/api/bot/webhook`;
}
