import { mtprotoConfigured } from "@/lib/telegram-user";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_PREMIUM } from "@/lib/upload-config";

/** The MTProto link state, as the browser is allowed to see it. */
export type LinkState = {
  available: boolean;
  /** Names of env vars this host is missing, so the UI can say which. */
  missingEnv: string[];
  linked: boolean;
  telegramUserId: string | null;
  premium: boolean;
  maxBytes: number;
};

/**
 * Shared by /api/telegram/link and the batched /api/overview, so the two can
 * never drift into disagreeing about whether an account is linked.
 */
export function describeLink(
  config: { mtprotoSession: string | null; mtprotoUserId: string | null; mtprotoPremium: boolean } | null
): LinkState {
  const linked = Boolean(config?.mtprotoSession);
  // Name the exact variables that are missing. "Unavailable" with no reason is
  // indistinguishable from a bug when the same build works on another host.
  const missingEnv = (["API_ID", "API_HASH", "SESSION_ENCRYPTION_KEY"] as const).filter(k => !process.env[k]);
  return {
    available: mtprotoConfigured(),
    // SESSION_ENCRYPTION_KEY is not needed to *start* a login, but without it
    // lib/crypto stores the Telegram session in clear text, so linking is
    // blocked rather than silently downgraded.
    missingEnv,
    linked,
    telegramUserId: config?.mtprotoUserId ?? null,
    premium: config?.mtprotoPremium ?? false,
    maxBytes: linked && config?.mtprotoPremium ? MAX_FILE_SIZE_PREMIUM : MAX_FILE_SIZE
  };
}
