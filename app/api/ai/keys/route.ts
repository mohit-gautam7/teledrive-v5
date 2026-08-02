import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { addKey, listKeys, VaultError } from "@/lib/ai/vault";
import { publicProviders, isProviderId } from "@/lib/ai/providers";

export const runtime = "nodejs";

/**
 * The bring-your-own-key vault.
 *
 * Responses carry `hint` (last four characters) and never the key itself, so a
 * compromised browser session cannot read back what was stored.
 */

function offResponse() {
  return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
}

const newKey = z.object({
  provider: z.string().refine(isProviderId, "Unknown provider."),
  nickname: z.string().trim().max(60).default(""),
  apiKey: z.string().min(1, "The API key is empty.").max(500),
  baseUrl: z.string().trim().max(300).optional().nullable(),
  // Presence is checked in the vault, which words it for a human; zod's own
  // "expected string, received undefined" is not a message to show a user.
  model: z.string().trim().max(120).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  /** Daily spend ceiling in micro-USD; omitted or null means no limit. */
  dailyLimitMicros: z.number().int().min(0).optional().nullable()
});

export async function GET() {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const keys = await listKeys(user.id);
    return NextResponse.json({
      providers: publicProviders(),
      // BigInt is not JSON-serialisable; the limit goes out as a number.
      keys: keys.map(k => ({ ...k, dailyLimitMicros: k.dailyLimitMicros === null ? null : Number(k.dailyLimitMicros) }))
    });
  } catch (error) {
    return jsonError(error, "Could not list AI keys.");
  }
}

export async function POST(request: NextRequest) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const input = newKey.parse(await request.json());

    const key = await addKey(user.id, {
      provider: input.provider,
      nickname: input.nickname,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl ?? null,
      model: input.model ?? null,
      priority: input.priority,
      dailyLimitMicros:
        input.dailyLimitMicros === undefined || input.dailyLimitMicros === null
          ? null
          : BigInt(input.dailyLimitMicros)
    });

    return NextResponse.json({
      key: { ...key, dailyLimitMicros: key.dailyLimitMicros === null ? null : Number(key.dailyLimitMicros) }
    });
  } catch (error) {
    if (error instanceof VaultError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return jsonError(error, "Could not save the AI key.");
  }
}
