import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { updateKey, deleteKey, VaultError } from "@/lib/ai/vault";

export const runtime = "nodejs";

function offResponse() {
  return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
}

// The secret itself is deliberately not patchable: rotating a key means adding
// the new one and deleting the old, so a half-applied edit can never leave a
// record whose hint disagrees with its ciphertext.
const patch = z.object({
  nickname: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().max(300).nullable().optional(),
  dailyLimitMicros: z.number().int().min(0).nullable().optional()
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const input = patch.parse(await request.json());

    const key = await updateKey(user.id, params.id, {
      ...input,
      dailyLimitMicros:
        input.dailyLimitMicros === undefined
          ? undefined
          : input.dailyLimitMicros === null
            ? null
            : BigInt(input.dailyLimitMicros)
    });

    return NextResponse.json({
      key: { ...key, dailyLimitMicros: key.dailyLimitMicros === null ? null : Number(key.dailyLimitMicros) }
    });
  } catch (error) {
    if (error instanceof VaultError) return NextResponse.json({ error: error.message }, { status: error.status });
    return jsonError(error, "Could not update the AI key.");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    await deleteKey(user.id, params.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof VaultError) return NextResponse.json({ error: error.message }, { status: error.status });
    return jsonError(error, "Could not delete the AI key.");
  }
}
