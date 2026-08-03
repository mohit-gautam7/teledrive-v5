import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  mtprotoConfigured,
  startQrLogin,
  pollQrLogin,
  startPhoneLogin,
  signInWithCode,
  signInWithPassword
} from "@/lib/telegram-user";
import {
  saveMtprotoSession,
  savePendingLogin,
  readPendingLogin,
  clearMtproto,
  clearPendingLogin
} from "@/lib/mtproto-session";
import { mapMtprotoError, isDeadSession } from "@/lib/mtproto-errors";
import { tgLog } from "@/lib/telegram-user";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_PREMIUM } from "@/lib/upload-config";
import { describeLink } from "@/lib/telegram-link";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Authorise the user's *own* Telegram account (MTProto) so large files can be
 * stored as single messages instead of hundreds of bot chunks.
 *
 * The flow spans several requests, so the half-built session is persisted
 * between them — a serverless function cannot hold a socket open in between.
 */

const body = z.union([
  z.object({ action: z.literal("qr-start") }),
  z.object({ action: z.literal("qr-poll") }),
  z.object({ action: z.literal("phone-start"), phone: z.string().min(5).max(20) }),
  z.object({ action: z.literal("phone-code"), code: z.string().min(3).max(10) }),
  z.object({ action: z.literal("password"), password: z.string().min(1) }),
  z.object({ action: z.literal("unlink") })
]);

export async function GET() {
  try {
    const user = await requireUser();
    const config = await prisma.storageConfig.findUnique({
      where: { userId: user.id },
      select: { mtprotoSession: true, mtprotoUserId: true, mtprotoPremium: true }
    });
    return NextResponse.json(describeLink(config));
  } catch (error) {
    return jsonError(error, "Could not read Telegram link status.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    rateLimit(`tg-link:${user.id}`, 40, 60_000);

    const input = body.parse(await request.json());

    if (input.action === "unlink") {
      await clearMtproto(user.id);
      return NextResponse.json({ ok: true, linked: false });
    }

    if (!mtprotoConfigured()) {
      const missing = (["API_ID", "API_HASH"] as const).filter(k => !process.env[k]);
      return NextResponse.json(
        { error: `Large-file storage is not configured on this server — missing ${missing.join(" and ")}.` },
        { status: 501 }
      );
    }
    // Refuse before a session exists rather than storing one unencrypted.
    if (!process.env.SESSION_ENCRYPTION_KEY) {
      return NextResponse.json(
        {
          error:
            "SESSION_ENCRYPTION_KEY is not set on this server, so your Telegram session cannot be stored encrypted. Linking is disabled until the site owner sets it."
        },
        { status: 503 }
      );
    }

    if (input.action === "qr-start") {
      const { pendingSession, qrUrl, expiresAt } = await startQrLogin();
      await savePendingLogin(user.id, pendingSession);
      return NextResponse.json({ status: "pending", qrUrl, expiresAt });
    }

    if (input.action === "phone-start") {
      const { pendingSession, phoneCodeHash, delivery } = await startPhoneLogin(input.phone);
      await savePendingLogin(user.id, pendingSession, phoneCodeHash, input.phone);
      return NextResponse.json({ status: "code-sent", delivery });
    }

    const pending = await readPendingLogin(user.id);
    if (!pending) {
      return NextResponse.json({ error: "No Telegram link in progress. Start again." }, { status: 409 });
    }

    if (input.action === "qr-poll") {
      const result = await pollQrLogin(pending.session);
      if (result.status === "authorized") {
        await saveMtprotoSession(user.id, result.session, result.userId, result.premium);
        // Prove the write landed: if this reads back false, the problem is
        // persistence, not the Telegram handshake.
        const check = await prisma.storageConfig.findUnique({
          where: { userId: user.id },
          select: { mtprotoSession: true }
        });
        tgLog("saveMtprotoSession stored=", Boolean(check?.mtprotoSession));
        return NextResponse.json({ status: "linked", premium: result.premium, name: result.name });
      }
      if (result.status === "password") {
        await savePendingLogin(user.id, result.pendingSession);
        return NextResponse.json({ status: "password" });
      }
      // The session string rotates as Telegram moves the login between data
      // centres, so persist whatever it is now — otherwise the next poll
      // reconnects with a stale one and the scan is never seen.
      await savePendingLogin(user.id, result.pendingSession);
      return NextResponse.json({
        status: "pending",
        state: result.state ?? "waiting",
        qrUrl: result.qrUrl,
        expiresAt: result.expiresAt
      });
    }

    if (input.action === "phone-code") {
      if (!pending.hash || !pending.phone) {
        return NextResponse.json({ error: "Request a new code first." }, { status: 409 });
      }
      const result = await signInWithCode(pending.session, pending.phone, pending.hash, input.code);
      if (result.status === "password") {
        await savePendingLogin(user.id, result.pendingSession, pending.hash, pending.phone);
        return NextResponse.json({ status: "password" });
      }
      await saveMtprotoSession(user.id, result.session, result.userId, result.premium);
      return NextResponse.json({ status: "linked", premium: result.premium, name: result.name });
    }

    // action === "password"
    const result = await signInWithPassword(pending.session, input.password);
    await saveMtprotoSession(user.id, result.session, result.userId, result.premium);
    return NextResponse.json({ status: "linked", premium: result.premium, name: result.name });
  } catch (error) {
    // Telegram's own failures are expected here (rate limits, wrong codes, 2FA)
    // and each has an answer the user can act on — surface it rather than a 500.
    const mapped = mapMtprotoError(error);
    if (mapped) {
      if (isDeadSession(error)) {
        // Only the half-finished login is discarded. Every error here comes from
        // a *pending* auth attempt, so clearing the stored link as well would
        // destroy a working connection — and make already-stored MTProto files
        // undownloadable — just because a re-link attempt went stale.
        await requireUser()
          .then(u => clearPendingLogin(u.id))
          .catch(() => {});
      }
      return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    }
    return jsonError(error, "Telegram account linking failed.");
  }
}
