import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  assertSameOrigin,
  clearPendingLinkCookie,
  readPendingLink,
  setBrowserApprovalCookie,
  setSessionCookie,
  signSession
} from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError } from "@/lib/api-response";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { mapMtprotoError } from "@/lib/mtproto-errors";
import { saveMtprotoSession } from "@/lib/mtproto-session";
import {
  mtprotoConfigured,
  pollQrLogin,
  signInWithCode,
  signInWithPassword,
  startBotChat,
  startPhoneLogin,
  startQrLogin,
  type Authorized
} from "@/lib/telegram-user";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sign in to TeleDrive with the Telegram account itself, by QR or phone code.
 *
 * One sign-in does what used to take three: it signs in to TeleDrive, links the
 * account so big files go to Saved Messages, and opens a window in which this
 * browser's own Telegram connection is approved without a second scan (see
 * /api/telegram/approve-browser). New accounts also get their bot chat opened.
 *
 * Same actions and answers as /api/telegram/link, so the same UI drives both.
 * The half-finished login lives in an encrypted, httpOnly cookie, since there is
 * no user row to keep it on yet.
 */

const PENDING_COOKIE = "teledrive_tg_login";

const body = z.union([
  z.object({ action: z.literal("qr-start") }),
  z.object({ action: z.literal("qr-poll") }),
  z.object({ action: z.literal("phone-start"), phone: z.string().min(5).max(20) }),
  z.object({ action: z.literal("phone-code"), code: z.string().min(3).max(10) }),
  z.object({ action: z.literal("password"), password: z.string().min(1).max(256) })
]);

type Pending = { session: string; hash?: string; phone?: string };

function keepPending(response: NextResponse, pending: Pending) {
  response.cookies.set(PENDING_COOKIE, encryptSecret(JSON.stringify(pending)) as string, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false",
    path: "/api/auth/telegram-account",
    maxAge: 600
  });
  return response;
}

async function readPending(): Promise<Pending | null> {
  const raw = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decryptSecret(raw) || "") as Pending;
    return parsed?.session ? parsed : null;
  } catch {
    return null;
  }
}

/** The account is authorised: sign in, link it, and open the browser window. */
async function finish(result: Authorized) {
  // An existing account is left as it is: its name and username key this
  // device's saved settings, so they must not shift under it.
  const existing = await prisma.user.findUnique({ where: { telegramId: result.userId } });
  const user =
    existing ??
    (await prisma.user.create({
      data: { telegramId: result.userId, name: result.name, username: result.username ?? null }
    }));

  // A bot cannot message first. For a new account, say hello from the user's
  // side so uploads through the bot work at once. Best effort, and before the
  // session is saved, because saving releases this host's socket.
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  if (!existing && bot) {
    await startBotChat(result.session, bot).catch(error => {
      console.warn("[telegram-account] could not open the bot chat:", (error as Error)?.message);
    });
  }

  await saveMtprotoSession(user.id, result.session, result.userId, result.premium);
  // "One login, everything direct": this device's downloads, previews and
  // uploads go straight to Telegram once it is connected — for older accounts
  // signing in again too, so nobody stays routed through the file server.
  await prisma.storageConfig.update({ where: { userId: user.id }, data: { directUpload: true } });

  const pendingLink = await readPendingLink();
  if (pendingLink) {
    await prisma.oAuthAccount.upsert({
      where: { provider_providerId: { provider: pendingLink.provider, providerId: pendingLink.providerId } },
      update: { userId: user.id, email: pendingLink.email ?? null },
      create: { userId: user.id, provider: pendingLink.provider, providerId: pendingLink.providerId, email: pendingLink.email ?? null }
    });
  }

  const response = NextResponse.json({
    status: "linked",
    premium: result.premium,
    name: result.name,
    user: { username: user.username, name: user.name }
  });
  setSessionCookie(response, signSession(user));
  setBrowserApprovalCookie(response, user.id);
  response.cookies.set(PENDING_COOKIE, "", { path: "/api/auth/telegram-account", maxAge: 0 });
  if (pendingLink) clearPendingLinkCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const ip = clientIp(request);
    rateLimit(`tg-account:${ip}`, 30, 60_000);
    if (!mtprotoConfigured() || !process.env.SESSION_ENCRYPTION_KEY) {
      return NextResponse.json({ error: "Telegram account sign-in is not configured on this server." }, { status: 501 });
    }

    const input = body.parse(await request.json());

    if (input.action === "qr-start") {
      const { pendingSession, qrUrl, expiresAt } = await startQrLogin();
      return keepPending(NextResponse.json({ status: "pending", qrUrl, expiresAt }), { session: pendingSession });
    }

    if (input.action === "phone-start") {
      // Each start makes Telegram send a code, so it is limited per caller and
      // across the route, which a rotated header cannot get round.
      rateLimit(`tg-account-code:${ip}`, 5, 10 * 60_000);
      rateLimit("tg-account-code:all", 60, 10 * 60_000);
      const { pendingSession, phoneCodeHash, delivery } = await startPhoneLogin(input.phone);
      return keepPending(NextResponse.json({ status: "code-sent", delivery }), {
        session: pendingSession,
        hash: phoneCodeHash,
        phone: input.phone
      });
    }

    const pending = await readPending();
    if (!pending) {
      return NextResponse.json({ error: "No Telegram sign-in in progress. Start again." }, { status: 409 });
    }

    if (input.action === "qr-poll") {
      const result = await pollQrLogin(pending.session);
      if (result.status === "authorized") return finish(result);
      if (result.status === "password") {
        return keepPending(NextResponse.json({ status: "password" }), { session: result.pendingSession });
      }
      return keepPending(
        NextResponse.json({ status: "pending", state: result.state ?? "waiting", qrUrl: result.qrUrl, expiresAt: result.expiresAt }),
        { session: result.pendingSession }
      );
    }

    if (input.action === "phone-code") {
      if (!pending.hash || !pending.phone) {
        return NextResponse.json({ error: "Request a new code first." }, { status: 409 });
      }
      const result = await signInWithCode(pending.session, pending.phone, pending.hash, input.code);
      if (result.status === "password") {
        return keepPending(NextResponse.json({ status: "password" }), { ...pending, session: result.pendingSession });
      }
      return finish(result);
    }

    return finish(await signInWithPassword(pending.session, input.password));
  } catch (error) {
    const mapped = mapMtprotoError(error);
    if (mapped) return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    return jsonError(error, "Telegram sign-in failed.");
  }
}
