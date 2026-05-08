import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  botToken: z.string().optional(),
  botChannelId: z.string().optional(),
  telegramSession: z.string().optional()
});

export async function GET() {
  const user = await requireUser();
  const config = await prisma.storageConfig.findUnique({ where: { userId: user.id } });
  return NextResponse.json({
    configured: {
      bot: Boolean(config?.botToken || process.env.BOT_TOKEN),
      channel: Boolean(config?.botChannelId || process.env.BOT_CHANNEL_ID),
      personal: Boolean(config?.telegramSession || process.env.TELEGRAM_SESSION)
    }
  });
}

export async function POST(request: NextRequest) {
  const user = await requireUser();
  const input = schema.parse(await request.json());
  const config = await prisma.storageConfig.upsert({
    where: { userId: user.id },
    update: {
      botToken: input.botToken || undefined,
      botChannelId: input.botChannelId || undefined,
      telegramSession: input.telegramSession ? encryptSecret(input.telegramSession) : undefined
    },
    create: {
      userId: user.id,
      botToken: input.botToken || null,
      botChannelId: input.botChannelId || null,
      telegramSession: input.telegramSession ? encryptSecret(input.telegramSession) : null
    }
  });
  return NextResponse.json({ ok: true, id: config.id });
}
