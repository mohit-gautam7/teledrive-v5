/**
 * Turn gramjs/Telegram RPC errors into an accurate status + a message a user can
 * act on.
 *
 * This exists because the default path was actively misleading: gramjs throws
 * `FloodWaitError` whose message reads "A wait of 26287 seconds is required" —
 * it contains no "FLOOD_WAIT" substring, so the generic string matching in
 * `jsonError` missed it and every one of these surfaced as a 500 rendered as
 * "The server had a problem." The user had no way to know they simply needed to
 * wait, or that the phone number was malformed.
 */

export type MappedError = { status: number; message: string };

function humanDuration(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds} seconds`;
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(totalSeconds / 3600);
  const rem = Math.ceil((totalSeconds % 3600) / 60);
  return rem ? `${hours}h ${rem}m` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Telegram's error identifier, e.g. "PHONE_CODE_INVALID".
 *
 * Telegram tacks a numeric suffix onto some of them — a bogus QR token really
 * comes back as `AUTH_TOKEN_INVALID1` — and a `_X` placeholder onto the waits,
 * so both are trimmed to leave a stable key.
 */
function rpcCode(error: unknown): string {
  const candidate = error as { errorMessage?: unknown; message?: unknown };
  const raw =
    typeof candidate?.errorMessage === "string"
      ? candidate.errorMessage
      : typeof candidate?.message === "string"
        ? candidate.message
        : "";
  return raw.replace(/_?\d+$/, "");
}

/** Seconds gramjs parsed out of a FLOOD_WAIT_x / SLOWMODE_WAIT_x error. */
function waitSeconds(error: unknown): number | null {
  const seconds = (error as { seconds?: unknown })?.seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds;
  // Fall back to the human message when the typed field is absent.
  const match = /A wait of (\d+) seconds/.exec(String((error as Error)?.message ?? ""));
  return match ? Number(match[1]) : null;
}

const EXACT: Record<string, MappedError> = {
  PHONE_NUMBER_INVALID: {
    status: 400,
    message: "That phone number isn't valid. Include the country code, for example +919876543210."
  },
  PHONE_NUMBER_BANNED: { status: 403, message: "Telegram has banned that phone number." },
  PHONE_NUMBER_UNOCCUPIED: { status: 400, message: "No Telegram account exists for that number." },
  PHONE_CODE_INVALID: { status: 400, message: "That code is incorrect. Check it and try again." },
  PHONE_CODE_EXPIRED: { status: 400, message: "That code expired. Request a new one." },
  PHONE_CODE_EMPTY: { status: 400, message: "Enter the code Telegram sent you." },
  PASSWORD_HASH_INVALID: { status: 401, message: "That cloud password is incorrect." },
  PASSWORD_REQUIRED: { status: 401, message: "This account needs its two-step verification password." },
  AUTH_TOKEN_EXPIRED: { status: 410, message: "The QR code expired. Generate a new one and scan again." },
  AUTH_TOKEN_ALREADY_ACCEPTED: { status: 409, message: "That QR code was already used. Generate a new one." },
  AUTH_TOKEN_INVALID: { status: 400, message: "That QR code is no longer valid. Generate a new one." },
  AUTH_KEY_UNREGISTERED: {
    status: 401,
    message: "This Telegram session is no longer authorised. Link your account again."
  },
  AUTH_KEY_INVALID: { status: 401, message: "This Telegram session is invalid. Link your account again." },
  SESSION_REVOKED: {
    status: 401,
    message: "This session was revoked from your Telegram devices. Link your account again."
  },
  SESSION_EXPIRED: { status: 401, message: "This Telegram session expired. Link your account again." },
  USER_DEACTIVATED: { status: 403, message: "That Telegram account is deactivated." },
  API_ID_INVALID: {
    status: 500,
    message: "This server's Telegram API_ID / API_HASH are wrong. Check the deployment configuration."
  },
  API_ID_PUBLISHED_FLOOD: {
    status: 429,
    message: "Telegram is throttling this server's API credentials. Try again later."
  }
};

/**
 * Map a Telegram/gramjs error, or return null if it isn't one so the caller can
 * fall back to its own handling.
 */
export function mapMtprotoError(error: unknown): MappedError | null {
  if (!error) return null;
  const code = rpcCode(error);
  const name = (error as Error)?.name ?? "";

  // Only treat this as a Telegram error if it actually looks like one. This
  // mapper runs from the global error handler, so keying off a bare `.seconds`
  // property would rewrite unrelated errors as rate limits.
  const looksTelegram = code.length > 0 || /^(RPCError|FloodWaitError|SlowModeWaitError)$/.test(name);
  if (!looksTelegram) return null;

  const isFlood = name === "FloodWaitError" || code.startsWith("FLOOD_WAIT") || code === "FLOOD";
  const isSlowMode = name === "SlowModeWaitError" || code.startsWith("SLOWMODE_WAIT");
  if (isFlood || isSlowMode) {
    const seconds = waitSeconds(error);
    const wait = seconds !== null ? ` Try again in ${humanDuration(seconds)}.` : " Try again shortly.";
    // Deliberately not "sign-in attempts": the same limit hits uploads,
    // downloads and deletes now that this mapper is used app-wide.
    return { status: 429, message: `Telegram is rate-limiting this server.${wait}` };
  }

  for (const [key, mapped] of Object.entries(EXACT)) {
    if (code === key || code.startsWith(`${key}_`)) return mapped;
  }

  // Telegram appends the DC number, e.g. PHONE_MIGRATE_5. gramjs follows these
  // automatically, so seeing one here means the migration itself failed.
  if (/^(PHONE|USER|NETWORK|FILE)_MIGRATE/.test(code)) {
    return { status: 503, message: "Telegram redirected the request to another data centre and it failed. Try again." };
  }

  return null;
}

/** True when the stored session is dead and should be cleared. */
export function isDeadSession(error: unknown): boolean {
  const code = rpcCode(error);
  return (
    code === "AUTH_KEY_UNREGISTERED" ||
    code === "AUTH_KEY_INVALID" ||
    code === "SESSION_REVOKED" ||
    code === "SESSION_EXPIRED" ||
    code === "USER_DEACTIVATED"
  );
}
