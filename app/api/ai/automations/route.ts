import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function offResponse() {
  return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
}

const step = z.union([
  z.object({ type: z.enum(["summarize", "ocr", "transcribe", "caption", "index", "favorite"]) }),
  z.object({ type: z.literal("translate"), language: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal("move"), folderId: z.string().max(80).nullable() })
]);

const create = z.object({
  name: z.string().trim().min(1).max(80),
  trigger: z.object({
    event: z.literal("file.uploaded"),
    mimePrefix: z.string().trim().max(60).optional(),
    nameContains: z.string().trim().max(120).optional()
  }),
  steps: z.array(step).min(1).max(8),
  enabled: z.boolean().optional()
});

export async function GET() {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const automations = await prisma.automation.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });
    return NextResponse.json({ automations });
  } catch (error) {
    return jsonError(error, "Could not list automations.");
  }
}

export async function POST(request: NextRequest) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const input = create.parse(await request.json());
    const automation = await prisma.automation.create({
      data: {
        userId: user.id,
        name: input.name,
        trigger: input.trigger as never,
        steps: input.steps as never,
        enabled: input.enabled ?? true
      }
    });
    return NextResponse.json({ automation });
  } catch (error) {
    return jsonError(error, "Could not create the automation.");
  }
}
