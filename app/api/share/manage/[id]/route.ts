import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";

const patchSchema = z.object({
  disabled: z.boolean().optional(),
  /** null clears the expiry, an ISO string sets it. */
  expiryDate: z.string().datetime().nullable().optional(),
  /** null/"" removes the password, a string sets a new one. */
  password: z.string().min(4).nullable().optional()
});

/** Confirm the share belongs to the caller before touching it. */
async function ownedShare(id: string, userId: string) {
  return prisma.share.findFirst({
    where: { id, OR: [{ file: { userId } }, { folder: { userId } }] }
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const share = await ownedShare(params.id, user.id);
    if (!share) return NextResponse.json({ error: "Share not found." }, { status: 404 });

    const input = patchSchema.parse(await request.json());
    const data: Record<string, unknown> = {};
    if (input.disabled !== undefined) data.disabled = input.disabled;
    if (input.expiryDate !== undefined) data.expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;
    if (input.password !== undefined) {
      data.passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;
    }

    const updated = await prisma.share.update({ where: { id: params.id }, data });
    return NextResponse.json({
      ok: true,
      share: {
        id: updated.id,
        disabled: updated.disabled,
        hasPassword: Boolean(updated.passwordHash),
        expiryDate: updated.expiryDate ? updated.expiryDate.toISOString() : null
      }
    });
  } catch (error) {
    return jsonError(error, "Could not update share.");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const share = await ownedShare(params.id, user.id);
    if (!share) return NextResponse.json({ error: "Share not found." }, { status: 404 });

    await prisma.share.delete({ where: { id: params.id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not revoke share.");
  }
}
