import crypto from "crypto";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";

export const AUTH_COOKIE = "teledrive_session";

export type SessionUser = {
  id: string;
  telegramId: string;
  name: string;
  username?: string | null;
  avatar?: string | null;
};

type TelegramAuthPayload = {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string | number;
  hash: string;
};

export function verifyTelegramAuth(payload: TelegramAuthPayload) {
  const botToken = String(requireEnv("BOT_TOKEN"));
  const { hash, ...data } = payload;
  const checkString = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHash("sha256").update(String(botToken)).digest();
  const digest = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  const fresh = Math.floor(Date.now() / 1000) - Number(payload.auth_date) < 86400;
  return fresh && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hash));
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, String(requireEnv("JWT_SECRET")), { expiresIn: "30d" });
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

export async function getCurrentUser() {
  const token = cookies().get(AUTH_COOKIE)?.value;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, String(requireEnv("JWT_SECRET"))) as unknown as SessionUser;
    return prisma.user.findUnique({ where: { id: decoded.id } });
  } catch {
    return null;
  }
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return user;
}

export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("host");
  if (!host || new URL(origin).host !== host) {
    throw new Response("Invalid origin", { status: 403 });
  }
}
