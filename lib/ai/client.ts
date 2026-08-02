import { getProvider, type ProviderSpec } from "@/lib/ai/providers";

/**
 * The one shape the rest of the app talks in. Adapters below translate it to
 * whatever a given provider wants, so callers never branch on provider.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

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
        messages: req.messages,
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
        messages
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
