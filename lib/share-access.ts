import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { streamInclude, StreamableFile } from "@/lib/file-stream";

/**
 * Every rule a public share link is subject to, in one place.
 *
 * All four public routes (the viewer's POST, the stream, the download, and any
 * future one) go through `loadSharedFile`, so revocation, expiry, the disabled
 * flag and the password are enforced server-side on the bytes themselves rather
 * than on the page that links to them. A share URL is a bearer token; the only
 * defence that counts is the one on the endpoint that serves the file.
 */

/** How long a correct password buys. Long enough to watch a film, short enough
 *  that a borrowed browser is not a permanent grant. */
const UNLOCK_TTL_SECONDS = 6 * 60 * 60;

function unlockCookieName(token: string) {
  return `td_share_${token}`;
}

/**
 * Prove that *this* browser gave the right password for *this* share.
 *
 * A signed cookie rather than a server session: there is nothing to store, it
 * cannot be replayed against another share because the token is inside the
 * signature, and it expires on its own.
 */
export function grantShareUnlock(response: NextResponse, token: string) {
  const value = jwt.sign({ share: token }, String(requireEnv("JWT_SECRET")), { expiresIn: UNLOCK_TTL_SECONDS });
  response.cookies.set(unlockCookieName(token), value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false",
    path: "/",
    maxAge: UNLOCK_TTL_SECONDS
  });
}

function hasUnlock(token: string) {
  const raw = cookies().get(unlockCookieName(token))?.value;
  if (!raw) return false;
  try {
    const claim = jwt.verify(raw, String(requireEnv("JWT_SECRET"))) as { share?: string };
    return claim.share === token;
  } catch {
    return false;
  }
}

export async function checkSharePassword(hash: string, supplied: unknown) {
  return typeof supplied === "string" && supplied.length > 0 && (await bcrypt.compare(supplied, hash));
}

/** Validate a public share token and return the streamable file, or an error. */
export async function loadSharedFile(token: string): Promise<
  | { file: StreamableFile & { originalName: string }; error?: undefined; status?: undefined }
  | { file?: undefined; error: string; status: number }
> {
  const share = await prisma.share.findUnique({
    where: { shareToken: token },
    include: { file: { include: streamInclude } }
  });

  // Revoked shares are deleted outright, so a missing row is a revoked link.
  // Disabled, deleted and unknown all answer identically: a 404 that
  // distinguished them would confirm which tokens exist.
  if (!share || share.disabled || !share.file || share.file.isDeleted) {
    return { error: "Share not found.", status: 404 };
  }
  if (share.expiryDate && share.expiryDate < new Date()) {
    return { error: "Share expired.", status: 410 };
  }
  // The password used to make a share undownloadable rather than protected:
  // this returned 401 for *every* request on a password share, including the
  // one from a viewer who had just typed the right password. The unlock cookie
  // is what the viewer's successful POST leaves behind.
  if (share.passwordHash && !hasUnlock(token)) {
    return { error: "This share is password protected. Open the share page and enter it.", status: 401 };
  }
  return { file: share.file };
}
