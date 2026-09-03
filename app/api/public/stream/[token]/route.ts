import { NextRequest, NextResponse } from "next/server";
import { streamFileResponse } from "@/lib/file-stream";
import { loadSharedFile } from "@/lib/share-access";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest, { params }: { params: { token: string } }) {
  try {
    // A shared video seeks by issuing a range request every few seconds, so
    // this has to be high enough not to interrupt playback and low enough
    // that one link cannot be used to pull the file in parallel forever.
    rateLimit(`share-stream:${params.token}:${request.ip || "local"}`, 240, 60_000);

    const result = await loadSharedFile(params.token);
    if (!result.file) return NextResponse.json({ error: result.error }, { status: result.status });

    return streamFileResponse(result.file, request.headers.get("range"), "inline");
  } catch (error) {
    return jsonError(error, "Streaming failed.");
  }
}
