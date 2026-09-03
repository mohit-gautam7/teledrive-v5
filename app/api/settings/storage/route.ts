import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";

/**
 * A user's own bot token and legacy session string.
 *
 * Both are credentials and both are now encrypted at rest — the token used to
 * go into the column verbatim, so anyone with a copy of the database could
 * drive that user's bot. Nothing here is ever read back: the response says only
 * whether each slot is filled.
 */
const schema = z.object({
  botToken: z.string().max(200).optional(),
  botChannelId: z.string().max(100).optional(),
  telegramSession: z.string().max(4000).optional()
});

export async function GET() {
  try {
    const user = await requireUser();
    const config = await prisma.storageConfig.findUnique({ where: { userId: user.id } });
    return NextResponse.json({
      configured: {
        bot: Boolean(config?.botToken || process.env.BOT_TOKEN),
        channel: Boolean(config?.botChannelId || process.env.BOT_CHANNEL_ID),
        personal: Boolean(config?.telegramSession || process.env.TELEGRAM_SESSION)
      }
    });
  } catch (error) {
    return jsonError(error, "Could not read the storage settings.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    rateLimit(`storage-settings:${user.id}`, 20, 60_000);
    const input = schema.parse(await request.json());
    const secrets = {
      botToken: input.botToken ? encryptSecret(input.botToken) : undefined,
      botChannelId: input.botChannelId || undefined,
      telegramSession: input.telegramSession ? encryptSecret(input.telegramSession) : undefined
    };
    const config = await prisma.storageConfig.upsert({
      where: { userId: user.id },
      update: secrets,
      create: {
        userId: user.id,
        botToken: secrets.botToken ?? null,
        botChannelId: secrets.botChannelId ?? null,
        telegramSession: secrets.telegramSession ?? null
      }
    });
    return NextResponse.json({ ok: true, id: config.id });
  } catch (error) {
    // Previously uncaught, so requireUser's thrown 401 surfaced as a 500.
    return jsonError(error, "Could not save the storage settings.");
  }
}
