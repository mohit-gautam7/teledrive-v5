import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { googleAuthUrl, googleConfigured } from "@/lib/google-oauth";

export const runtime = "nodejs";

const STATE_COOKIE = "teledrive_oauth_state";

export async function GET(request: NextRequest) {
  if (!googleConfigured()) {
    return NextResponse.json({ error: "Google sign-in is not configured on this server." }, { status: 501 });
  }
  const origin = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  const state = crypto.randomBytes(16).toString("hex");

  const response = NextResponse.redirect(googleAuthUrl(origin, state));
  // CSRF guard: the callback must present the same value back to us.
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false",
    path: "/",
    maxAge: 600
  });
  return response;
}
