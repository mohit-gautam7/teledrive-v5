/**
 * Google sign-in (OAuth 2.0 authorization-code flow).
 *
 * Google is only a *login* — storage always resolves through the user's Telegram
 * account, so a Google identity that isn't linked yet is parked in a short-lived
 * cookie until the user confirms it with a bot code once.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(origin: string) {
  return `${origin.replace(/\/$/, "")}/api/auth/google/callback`;
}

export function googleAuthUrl(origin: string, state: string) {
  const params = new URLSearchParams({
    client_id: String(process.env.GOOGLE_CLIENT_ID),
    redirect_uri: googleRedirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account"
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export type GoogleIdentity = { sub: string; email?: string; name?: string; picture?: string };

/**
 * Exchange the one-time code for an id_token.
 *
 * The token arrives over a direct server-to-server TLS call to Google's token
 * endpoint, authenticated with our client secret, so its claims are trustworthy
 * without a separate JWKS signature check (this is the flow Google documents for
 * confidential clients).
 */
export async function exchangeGoogleCode(code: string, origin: string): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: String(process.env.GOOGLE_CLIENT_ID),
      client_secret: String(process.env.GOOGLE_CLIENT_SECRET),
      redirect_uri: googleRedirectUri(origin),
      grant_type: "authorization_code"
    })
  });

  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.id_token) {
    throw new Error(body.error_description || body.error || "Google rejected the sign-in.");
  }

  const payloadSegment = body.id_token.split(".")[1];
  if (!payloadSegment) throw new Error("Google returned a malformed id_token.");
  const claims = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as GoogleIdentity & {
    aud?: string;
  };

  if (!claims.sub) throw new Error("Google returned no account id.");
  if (claims.aud && claims.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Google token was issued for a different application.");
  }
  return { sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture };
}
