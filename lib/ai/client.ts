import { getProvider, type ProviderSpec } from "@/lib/ai/providers";

/**
 * The one shape the rest of the app talks in. Adapters below translate it to
 * whatever a given provider wants, so callers never branch on provider.
 */

/** An image sent alongside a prompt, for OCR and captioning. */
export type InlineImage = { mimeType: string; base64: string };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /** Requires a vision-capable model; the adapters translate to each provider's
   *  own multimodal shape. */
  images?: InlineImage[];
};

export type ChatRequest = {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type ChatResult = {
  text: string;
  promptTokens: number;
  completionTokens: number;
};

/**
 * A provider call that failed in a way worth distinguishing.
 *
 * `retryable` drives the router: a 429 or a 5xx is worth trying again or moving
 * to the next key, while a 401 means this key is simply wrong and should be
 * taken out of rotation rather than retried against.
 */
export class ProviderError extends Error {
  status: number;
  retryable: boolean;
  /** True when the key itself is rejected — the router disables it. */
  credentialFailure: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.credentialFailure = status === 401 || status === 403;
    this.retryable = status === 429 || status >= 500 || status === 0;
  }
}

const DEFAULT_MAX_TOKENS = 1024;
const TIMEOUT_MS = 120_000;

async function readError(res: Response) {
  // Providers disagree on error shape; the message is for logs and the usage
  // record, so a best-effort extraction is enough.
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || parsed?.message || body.slice(0, 300);
  } catch {
    return body.slice(0, 300) || res.statusText;
  }
}

/** Caller-supplied cancellation, plus a ceiling so a hung provider cannot pin a
 *  worker forever. */
function withTimeout(signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function chatOpenAiCompatible(
  spec: ProviderSpec,
  apiKey: string,
  baseUrl: string,
  req: ChatRequest
): Promise<ChatResult> {
  const { signal, done } = withTimeout(req.signal);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: req.model,
        // A plain string stays a string: some OpenAI-compatible servers (several
        // local runtimes among them) reject the content-parts array outright.
        messages: req.messages.map(m =>
          m.images?.length
            ? {
                role: m.role,
                content: [
                  { type: "text", text: m.content },
                  ...m.images.map(img => ({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
                  }))
                ]
              }
            : { role: m.role, content: m.content }
        ),
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature })
      }),
      signal
    });

    if (!res.ok) throw new ProviderError(`${spec.label}: ${await readError(res)}`, res.status);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    // A DNS failure or a refused connection is a real possibility for a
    // self-hosted endpoint; status 0 marks it retryable but not a bad key.
    throw new ProviderError(`${spec.label}: ${(err as Error).message}`, 0);
  } finally {
    done();
  }
}

async function chatAnthropic(
  spec: ProviderSpec,
  apiKey: string,
  baseUrl: string,
  req: ChatRequest
): Promise<ChatResult> {
  const { signal, done } = withTimeout(req.signal);
  try {
    // Anthropic takes the system prompt as a top-level field rather than a message.
    const system = req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const messages = req.messages.filter(m => m.role !== "system");

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: messages.map(m =>
          m.images?.length
            ? {
                role: m.role,
                content: [
                  { type: "text", text: m.content },
                  ...m.images.map(img => ({
                    type: "image",
                    source: { type: "base64", media_type: img.mimeType, data: img.base64 }
                  }))
                ]
              }
            : { role: m.role, content: m.content }
        )
      }),
      signal
    });

    if (!res.ok) throw new ProviderError(`${spec.label}: ${await readError(res)}`, res.status);

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: (json.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join(""),
      promptTokens: json.usage?.input_tokens ?? 0,
      completionTokens: json.usage?.output_tokens ?? 0
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${spec.label}: ${(err as Error).message}`, 0);
  } finally {
    done();
  }
}

/**
 * Single entry point. `baseUrl` comes from the key when set, otherwise the
 * provider default; a provider with no default (local) requires it.
 */
export async function chat(
  providerId: string,
  apiKey: string,
  baseUrlOverride: string | null,
  req: ChatRequest
): Promise<ChatResult> {
  const spec = getProvider(providerId);
  if (!spec) throw new ProviderError(`Unknown provider "${providerId}".`, 400);

  const baseUrl = baseUrlOverride || spec.baseUrl;
  if (!baseUrl) throw new ProviderError(`${spec.label} needs a base URL on the key.`, 400);

  return spec.kind === "anthropic"
    ? chatAnthropic(spec, apiKey, baseUrl, req)
    : chatOpenAiCompatible(spec, apiKey, baseUrl, req);
}

/**
 * Vector embeddings, for semantic search.
 *
 * Only the OpenAI-compatible shape — Anthropic has no embeddings endpoint, so
 * a key for it is rejected here rather than failing obscurely upstream.
 */
export async function embed(
  providerId: string,
  apiKey: string,
  baseUrlOverride: string | null,
  model: string,
  input: string[],
  signal?: AbortSignal
): Promise<{ vectors: number[][]; promptTokens: number }> {
  const spec = getProvider(providerId);
  if (!spec) throw new ProviderError(`Unknown provider "${providerId}".`, 400);
  if (spec.kind === "anthropic") {
    throw new ProviderError("Anthropic does not provide embeddings. Use another provider for semantic search.", 400);
  }
  const baseUrl = baseUrlOverride || spec.baseUrl;
  if (!baseUrl) throw new ProviderError(`${spec.label} needs a base URL on the key.`, 400);

  const { signal: timed, done } = withTimeout(signal);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input }),
      signal: timed
    });
    if (!res.ok) throw new ProviderError(`${spec.label}: ${await readError(res)}`, res.status);

    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: { prompt_tokens?: number };
    };
    const vectors = (json.data ?? []).map(d => d.embedding ?? []);
    if (vectors.length !== input.length) {
      throw new ProviderError(`${spec.label} returned ${vectors.length} embeddings for ${input.length} inputs.`, 502);
    }
    return { vectors, promptTokens: json.usage?.prompt_tokens ?? 0 };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${spec.label}: ${(err as Error).message}`, 0);
  } finally {
    done();
  }
}

/**
 * Speech to text. Uses the OpenAI-compatible `/audio/transcriptions` multipart
 * endpoint, which is what Groq, OpenAI and most local Whisper servers expose.
 */
export async function transcribe(
  providerId: string,
  apiKey: string,
  baseUrlOverride: string | null,
  model: string,
  audio: { bytes: Buffer; filename: string; mimeType: string },
  signal?: AbortSignal
): Promise<{ text: string }> {
  const spec = getProvider(providerId);
  if (!spec) throw new ProviderError(`Unknown provider "${providerId}".`, 400);
  if (spec.kind === "anthropic") {
    throw new ProviderError("Anthropic does not transcribe audio. Use another provider for transcripts.", 400);
  }
  const baseUrl = baseUrlOverride || spec.baseUrl;
  if (!baseUrl) throw new ProviderError(`${spec.label} needs a base URL on the key.`, 400);

  const { signal: timed, done } = withTimeout(signal);
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }), audio.filename);
    form.append("model", model);

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` }, // no content-type: fetch sets the multipart boundary
      body: form,
      signal: timed
    });
    if (!res.ok) throw new ProviderError(`${spec.label}: ${await readError(res)}`, res.status);

    const json = (await res.json()) as { text?: string };
    return { text: json.text ?? "" };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${spec.label}: ${(err as Error).message}`, 0);
  } finally {
    done();
  }
}
