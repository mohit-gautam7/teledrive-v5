import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setSessionCookie, signSession, setPendingLinkCookie } from "@/lib/auth";
import { exchangeGoogleCode, googleConfigured } from "@/lib/google-oauth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const STATE_COOKIE = "teledrive_oauth_state";

function back(origin: string, params: Record<string, string>) {
  const url = new URL("/", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;

  try {
    if (!googleConfigured()) return back(origin, { error: "Google sign-in is not configured." });
    rateLimit(`google:${clientIp(request)}`, 20, 60_000);

    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const expected = request.cookies.get(STATE_COOKIE)?.value;

    if (!code) return back(origin, { error: "Google sign-in was cancelled." });
    if (!state || !expected || state !== expected) {
      return back(origin, { error: "Google sign-in expired. Please try again." });
    }

    const identity = await exchangeGoogleCode(code, origin);

    const account = await prisma.oAuthAccount.findUnique({
      where: { provider_providerId: { provider: "google", providerId: identity.sub } },
      include: { user: true }
    });

    // Already linked → straight in.
    if (account) {
      const response = NextResponse.redirect(new URL("/drive", origin));
      setSessionCookie(response, signSession(account.user));
      response.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
      return response;
    }

    // First time: park the verified Google identity and ask for a bot code once,
    // because storage needs a Telegram chat that Google can't supply.
    const response = back(origin, { link: "google" });
    setPendingLinkCookie(response, { provider: "google", providerId: identity.sub, email: identity.email });
    response.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    return back(origin, { error: error instanceof Error ? error.message : "Google sign-in failed." });
  }
}
