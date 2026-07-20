import { NextRequest, NextResponse } from "next/server";
import { streamFileResponse } from "@/lib/file-stream";
import { loadSharedFile } from "@/lib/share-access";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const result = await loadSharedFile(params.token);
    if (!result.file) return NextResponse.json({ error: result.error }, { status: result.status });

    return streamFileResponse(result.file, request.headers.get("range"), "attachment");
  } catch (error) {
    return jsonError(error, "Download failed.");
  }
}
