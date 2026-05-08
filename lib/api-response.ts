import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function jsonError(error: unknown, fallback = "Something went wrong.") {
  if (error instanceof Response) return error;
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message || "Invalid request." }, { status: 400 });
  }
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("FLOOD_WAIT")) {
      return NextResponse.json({ error: "Telegram is rate limiting this action. Please wait and retry." }, { status: 429 });
    }
    if (message.includes("AUTH_KEY_UNREGISTERED")) {
      return NextResponse.json({ error: "Telegram personal session expired. Reconnect Telegram in Settings." }, { status: 401 });
    }
    if (message.includes("entity too large") || message.includes("Request Entity Too Large")) {
      return NextResponse.json({ error: "This upload is too large for the current server limit." }, { status: 413 });
    }
    return NextResponse.json({ error: message || fallback }, { status: 500 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}
