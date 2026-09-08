import crypto from "crypto";
import jwt from "jsonwebtoken";
import { cookies, headers } from "next/headers";
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
  // timingSafeEqual throws on length mismatch, so compare lengths first —
  // a malformed hash must be rejected, not turned into a 500.
  const expected = Buffer.from(digest, "utf8");
  const supplied = Buffer.from(String(hash ?? ""), "utf8");
  if (expected.length !== supplied.length) return false;
  return fresh && crypto.timingSafeEqual(expected, supplied);
}

const LINK_COOKIE = "teledrive_link";

export type PendingLink = { provider: string; providerId: string; email?: string | null };

/** Short-lived cookie carrying a verified third-party identity that still needs
 *  to be attached to a Telegram account before it can be used to sign in. */
export function setPendingLinkCookie(response: NextResponse, link: PendingLink) {
  const token = jwt.sign(link, String(requireEnv("JWT_SECRET")), { expiresIn: "15m" });
  response.cookies.set(LINK_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false",
    path: "/",
    maxAge: 900
  });
}

export function readPendingLink(): PendingLink | null {
  const token = cookies().get(LINK_COOKIE)?.value;
  if (!token) return null;
  try {
    return jwt.verify(token, String(requireEnv("JWT_SECRET"))) as unknown as PendingLink;
  } catch {
    return null;
  }
}

export function clearPendingLinkCookie(response: NextResponse) {
  response.cookies.set(LINK_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, String(requireEnv("JWT_SECRET")), { expiresIn: "30d" });
}

/**
 * The credential the file origin accepts.
 *
 * When the app is split across two origins (see lib/file-origin.ts), the session
 * cookie cannot reach the second one: it is httpOnly and SameSite=Lax, which is
 * correct and which also means the browser will not send it there and script
 * cannot read it to forward it. This is the narrower thing that goes instead —
 * signed with the same JWT_SECRET, so the file origin needs no shared state
 * beyond the secret it already has, and marked with a scope so it can never be
 * used as a session.
 *
 * One hour, and only the user id: it travels in an Authorization header for
 * fetches and in a query string for `<img>`/`<video>`, and a query string is the
 * kind of place a credential ends up in a log.
 */
const FILE_SCOPE = "files";

export function signFileToken(userId: string) {
  return jwt.sign({ id: userId, scope: FILE_SCOPE }, String(requireEnv("JWT_SECRET")), { expiresIn: "1h" });
}

/** A bearer token from the Authorization header, if there is one. */
function bearerToken() {
  try {
    const value = headers().get("authorization");
    if (!value) return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() || null : null;
  } catch {
    // headers() throws outside a request scope; there is simply no bearer then.
    return null;
  }
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false",
    path: "/",
    maxAge: 0
  });
}

/**
 * Who is making this request.
 *
 * Three places a credential can arrive, in order of preference:
 *
 *  1. the session cookie — the normal case, and the only one on a single-origin
 *     deployment;
 *  2. `Authorization: Bearer` — a fetch to the file origin, which the cookie
 *     cannot reach;
 *  3. `?t=` — an `<img>`, `<video>` or browser download against the file origin,
 *     where there is no way to set a header at all.
 *
 * `request` is only needed for the third; every route that is not loaded
 * directly by the browser can keep calling `requireUser()` with no argument.
 *
 * The scope check in the middle is the point of the whole arrangement. A
 * file-scoped token presented as a session cookie is rejected, and a full
 * session token presented as a bearer is rejected too. Each credential works
 * only on the path it was minted for, so the short-lived token that ends up in a
 * URL cannot be replayed as a login.
 */
export async function getCurrentUser(request?: NextRequest) {
  const cookieToken = cookies().get(AUTH_COOKIE)?.value ?? null;
  const presented = cookieToken ?? bearerToken() ?? request?.nextUrl.searchParams.get("t") ?? null;
  if (!presented) return null;
  try {
    const decoded = jwt.verify(presented, String(requireEnv("JWT_SECRET"))) as unknown as SessionUser & {
      scope?: string;
    };
    const isFileToken = decoded.scope === FILE_SCOPE;
    if (isFileToken === Boolean(cookieToken)) return null;
    if (!decoded.id) return null;
    return prisma.user.findUnique({ where: { id: decoded.id } });
  } catch {
    return null;
  }
}

export async function requireUser(request?: NextRequest) {
  const user = await getCurrentUser(request);
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
