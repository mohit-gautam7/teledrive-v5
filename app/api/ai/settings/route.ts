import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { AI_MODES, readPreferences, writePreferences } from "@/lib/ai/modes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function offResponse() {
  return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
}

const strategy = z.enum(["priority", "round-robin", "least-used", "lowest-cost", "fastest"]);
const mode = z.enum(AI_MODES);

const body = z.object({
  mode,
  strategy,
  taskOverrides: z
    .record(
      z.string().min(1).max(60),
      z.object({
        mode: mode.optional(),
        strategy: strategy.optional(),
        providers: z.array(z.string().max(40)).max(12).optional()
      })
    )
    .default({})
});

export async function GET() {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    return NextResponse.json({ preferences: await readPreferences(user.id), modes: AI_MODES });
  } catch (error) {
    return jsonError(error, "Could not read AI settings.");
  }
}

export async function PUT(request: NextRequest) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const input = body.parse(await request.json());
    await writePreferences(user.id, input);
    return NextResponse.json({ preferences: await readPreferences(user.id) });
  } catch (error) {
    return jsonError(error, "Could not save AI settings.");
  }
}
