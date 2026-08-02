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

const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional()
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const owned = await prisma.automation.findFirst({ where: { id: params.id, userId: user.id }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Automation not found." }, { status: 404 });

    const automation = await prisma.automation.update({
      where: { id: params.id },
      data: patch.parse(await request.json())
    });
    return NextResponse.json({ automation });
  } catch (error) {
    return jsonError(error, "Could not update the automation.");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!aiEnabled()) return offResponse();
  try {
    const user = await requireUser();
    const owned = await prisma.automation.findFirst({ where: { id: params.id, userId: user.id }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
    await prisma.automation.delete({ where: { id: params.id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not delete the automation.");
  }
}
