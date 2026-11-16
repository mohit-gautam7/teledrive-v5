import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
/** Small connectivity probe; no credentials, file reads, or dependency calls. */
export function GET() {
  return NextResponse.json({ service: "teledrive", ok: true }, { headers: { "cache-control": "no-store" } });
}
