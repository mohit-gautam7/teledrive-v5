import { NextResponse } from "next/server";
import { googleConfigured } from "@/lib/google-oauth";

export const runtime = "nodejs";
// Reads env at request time; without this Next prerenders the route and bakes
// the build-time values in, so a provider enabled later would never show up.
export const dynamic = "force-dynamic";

/** Which sign-in methods this deployment actually has configured, so the login
 *  page only offers buttons that can work. */
export async function GET() {
  return NextResponse.json({
    botCode: Boolean(process.env.BOT_TOKEN),
    widget: Boolean(process.env.BOT_TOKEN && process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME),
    google: googleConfigured(),
    ownerKey: Boolean(process.env.OWNER_LOGIN_KEY)
  });
}
