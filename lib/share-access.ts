import { prisma } from "@/lib/prisma";
import { streamInclude, StreamableFile } from "@/lib/file-stream";

/** Validate a public share token and return the streamable file, or an error. */
export async function loadSharedFile(token: string): Promise<
  | { file: StreamableFile & { originalName: string }; error?: undefined; status?: undefined }
  | { file?: undefined; error: string; status: number }
> {
  const share = await prisma.share.findUnique({
    where: { shareToken: token },
    include: { file: { include: streamInclude } }
  });

  if (!share || share.disabled || !share.file || share.file.isDeleted) {
    return { error: "Share not found.", status: 404 };
  }
  if (share.expiryDate && share.expiryDate < new Date()) {
    return { error: "Share expired.", status: 410 };
  }
  if (share.passwordHash) {
    return { error: "Password protected shares must be opened in the share page.", status: 401 };
  }
  return { file: share.file };
}
