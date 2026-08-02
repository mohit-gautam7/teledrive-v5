import { readEntireFile, type StreamableFile } from "@/lib/file-stream";
import { run, runTranscribe } from "@/lib/ai/router";
import { resolvePlan } from "@/lib/ai/modes";
import type { ChatMessage } from "@/lib/ai/client";

/**
 * AI actions that operate on a stored file.
 *
 * Everything here shares one shape: fetch the bytes back out of Telegram, turn
 * them into something a model accepts, and run it through the router so mode,
 * key rotation, metering and health all behave exactly as they do elsewhere.
 */

export const FILE_ACTIONS = ["summarize", "translate", "chat", "ocr", "caption", "transcribe"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

export function isFileAction(value: string): value is FileAction {
  return (FILE_ACTIONS as readonly string[]).includes(value);
}

export class FileTaskError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "FileTaskError";
    this.status = status;
  }
}

/**
 * Text this app can read without a document-parsing dependency.
 *
 * PDF and DOCX are deliberately absent: extracting them needs a parser we do
 * not ship, and guessing at their bytes produces convincing nonsense rather
 * than an error. They are rejected with a message that says so.
 */
const TEXT_LIKE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|sql|csv))/;
const BINARY_DOC = /^application\/(pdf|msword|vnd\.openxmlformats|vnd\.ms-|epub)/;

/** How much of a long document is sent. Roughly 30k tokens at 4 chars/token,
 *  which fits comfortably in a modern context window and bounds the bill. */
const MAX_TEXT_CHARS = 120_000;

function decodeText(bytes: Buffer, mimeType: string, filename: string) {
  if (BINARY_DOC.test(mimeType)) {
    throw new FileTaskError(
      `${filename} is a ${mimeType.split("/")[1]} document. TeleDrive does not extract text from it yet — convert it to text or Markdown first.`
    );
  }
  if (!TEXT_LIKE.test(mimeType)) {
    throw new FileTaskError(`${filename} is not a text file (${mimeType}).`);
  }
  const text = bytes.toString("utf8");
  if (!text.trim()) throw new FileTaskError(`${filename} is empty.`);
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]` : text;
}

function promptFor(action: FileAction, name: string, text: string, opts: { question?: string; language?: string }): ChatMessage[] {
  switch (action) {
    case "summarize":
      return [
        { role: "system", content: "Summarize the document faithfully. Do not add facts that are not present." },
        { role: "user", content: `Summarize "${name}":\n\n${text}` }
      ];
    case "translate":
      return [
        {
          role: "system",
          content: "Translate the text exactly, preserving structure and formatting. Output only the translation."
        },
        { role: "user", content: `Translate "${name}" into ${opts.language || "English"}:\n\n${text}` }
      ];
    case "chat":
      return [
        {
          role: "system",
          content:
            "Answer using only the document. If the answer is not in it, say so plainly rather than guessing."
        },
        { role: "user", content: `Document "${name}":\n\n${text}\n\nQuestion: ${opts.question}` }
      ];
    default:
      throw new FileTaskError(`${action} is not a text action.`);
  }
}

export type FileTaskInput = {
  userId: string;
  file: StreamableFile & { originalName: string; mimeType: string };
  action: FileAction;
  question?: string;
  language?: string;
  signal?: AbortSignal;
};

export type FileTaskResult = {
  action: FileAction;
  text: string;
  provider: string;
  model: string;
  costMicros?: number | null;
};

export async function runFileTask(input: FileTaskInput): Promise<FileTaskResult> {
  const { file, action } = input;
  const mimeType = file.mimeType || "application/octet-stream";
  const name = file.originalName;

  if (action === "chat" && !input.question?.trim()) {
    throw new FileTaskError("Ask a question to chat with this document.");
  }

  // readEntireFile refuses anything over 25 MB, which is the right ceiling here
  // too: the whole file has to sit in memory to be sent to a provider.
  const bytes = await readEntireFile(file);
  if (!bytes) {
    throw new FileTaskError("This file is too large for AI processing (the limit is 25 MB).", 413);
  }

  const plan = await resolvePlan(input.userId, action);
  const shared = {
    userId: input.userId,
    task: action,
    providers: plan.providers,
    strategy: plan.strategy,
    localOnly: plan.localOnly,
    freeOnly: plan.freeOnly,
    signal: input.signal
  };

  if (action === "transcribe") {
    if (!/^(audio|video)\//.test(mimeType)) {
      throw new FileTaskError(`${name} is not audio or video (${mimeType}).`);
    }
    const out = await runTranscribe({ ...shared, audio: { bytes, filename: name, mimeType } });
    return { action, text: out.text, provider: out.provider, model: out.model };
  }

  if (action === "ocr" || action === "caption") {
    if (!mimeType.startsWith("image/")) {
      throw new FileTaskError(`${name} is not an image (${mimeType}).`);
    }
    const instruction =
      action === "ocr"
        ? "Transcribe all text visible in this image, preserving line breaks. Output only the text. If there is none, say so."
        : "Describe this image in two or three sentences.";
    const out = await run({
      ...shared,
      messages: [{ role: "user", content: instruction, images: [{ mimeType, base64: bytes.toString("base64") }] }],
      maxTokens: 2048
    });
    return { action, text: out.text, provider: out.provider, model: out.model, costMicros: out.costMicros };
  }

  const text = decodeText(bytes, mimeType, name);
  const out = await run({
    ...shared,
    messages: promptFor(action, name, text, { question: input.question, language: input.language }),
    maxTokens: 2048
  });
  return { action, text: out.text, provider: out.provider, model: out.model, costMicros: out.costMicros };
}

/** Plain text for indexing, or null when the file has no extractable text. */
export async function extractIndexableText(
  file: StreamableFile & { originalName: string; mimeType: string }
): Promise<string | null> {
  const mimeType = file.mimeType || "";
  if (!TEXT_LIKE.test(mimeType)) return null;
  const bytes = await readEntireFile(file);
  if (!bytes) return null;
  const text = bytes.toString("utf8").trim();
  return text ? text.slice(0, MAX_TEXT_CHARS) : null;
}
