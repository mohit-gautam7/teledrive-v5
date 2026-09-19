import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { checkSharePassword, grantShareUnlock } from "@/lib/share-access";

export const runtime = "nodejs";

export async function POST(request: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  try {
    // A share password is the only credential in this app that an anonymous
    // caller may guess at, so it is the one that needs a ceiling. Keyed by
    // token as well as address: one person hammering one link must not lock
    // everyone else out of every other share.
    rateLimit(`share-open:${params.token}:${clientIp(request)}`, 20, 60_000);

    const body = await request.json().catch(() => ({}));
    const share = await prisma.share.findUnique({
      where: { shareToken: params.token },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      include: { file: true, folder: true } as any
    });
    if (!share || share.disabled) {
      return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = share as any;
    if (s.file && s.file.isDeleted) {
      return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
    }
    if (share.expiryDate && share.expiryDate < new Date()) {
      return NextResponse.json({ error: "Share link expired." }, { status: 410 });
    }
    if (share.passwordHash && !(await checkSharePassword(share.passwordHash, body.password))) {
      return NextResponse.json({ passwordRequired: true }, { status: 401 });
    }

    // Folder share — return folder info + files list
    let payload: NextResponse;
    if (s.folderId && s.folder) {
      const files = await prisma.file.findMany({
        // Scoped to the folder's owner as well as the folder. A folder id is
        // not proof of ownership on its own, and a share must never widen to
        // include a row someone else managed to point at this folder.
        where: { folderId: s.folderId, userId: s.folder.userId, isDeleted: false },
        orderBy: { createdAt: "desc" }
      });
      payload = NextResponse.json({
        folder: { id: s.folder.id, name: s.folder.name },
        files: files.map((f: Parameters<typeof toPublicFile>[0]) => toPublicFile(f))
      });
    } else if (!s.file) {
      return NextResponse.json({ error: "Share link is unavailable." }, { status: 404 });
    } else {
      payload = NextResponse.json({ file: toPublicFile(s.file) });
    }

    // The password was right, so this browser may now fetch the bytes. Without
    // this the download and stream endpoints have no way to tell an unlocked
    // viewer from a stranger holding the same URL — which is why they used to
    // refuse a password-protected share outright.
    if (share.passwordHash) grantShareUnlock(payload, params.token);
    return payload;
  } catch (error) {
    return jsonError(error, "Could not open that share link.");
  }
}
