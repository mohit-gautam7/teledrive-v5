/**
 * Which model providers the vault can hold keys for, and how to talk to each.
 *
 * Almost every provider now speaks the OpenAI chat-completions shape, so one
 * adapter covers most of the list and each new provider is a table entry rather
 * than a new client. Anthropic is the exception and has its own adapter.
 *
 * `baseUrl` here is only a default: every key may override it. That override is
 * what makes "local AI" work — the user points a key at their own machine
 * (Ollama, LM Studio, llama.cpp, vLLM), and nothing about the request leaves it.
 */

export type ProviderKind = "openai-compatible" | "anthropic";

export type ProviderSpec = {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Default endpoint. Null means the user must supply one for every key. */
  baseUrl: string | null;
  /**
   * Model used when a key does not name one.
   *
   * Every key used to have to carry a model, which made adding one a research
   * task: the user had to know the provider's exact model string before they
   * could save anything. A default per provider makes the field an override
   * instead — a small, current, widely-available model that any account with a
   * valid key can reach.
   */
  defaultModel: string;
  /** Where to get a key — shown in the UI next to the field. */
  keysUrl?: string;
  /** True when the endpoint is the user's own machine, not a hosted service. */
  local?: boolean;
};

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "openai/gpt-4o-mini",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keysUrl: "https://openrouter.ai/keys"
  },
  {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keysUrl: "https://console.groq.com/keys"
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.0-flash",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keysUrl: "https://aistudio.google.com/apikey"
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keysUrl: "https://platform.openai.com/api-keys"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-sonnet-5",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keysUrl: "https://console.anthropic.com/settings/keys"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys"
  },
  {
    id: "together",
    label: "Together AI",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    keysUrl: "https://api.together.ai/settings/api-keys"
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    kind: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keysUrl: "https://fireworks.ai/account/api-keys"
  },
  {
    id: "cohere",
    label: "Cohere",
    defaultModel: "command-r-plus",
    kind: "openai-compatible",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keysUrl: "https://dashboard.cohere.com/api-keys"
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    kind: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    keysUrl: "https://huggingface.co/settings/tokens"
  },
  {
    // Ollama, LM Studio, llama.cpp and vLLM all expose the OpenAI shape, so they
    // differ only in the URL the user gives — hence one entry, not four.
    id: "local",
    label: "Local (OpenAI-compatible)",
    defaultModel: "llama3.2",
    kind: "openai-compatible",
    baseUrl: null,
    local: true
  }
];

const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));

export function getProvider(id: string): ProviderSpec | null {
  return BY_ID.get(id) ?? null;
}

export function isProviderId(id: string): boolean {
  return BY_ID.has(id);
}

/** Safe to send to the browser — contains no secrets. */
export function publicProviders() {
  return PROVIDERS.map(({ id, label, baseUrl, keysUrl, local, defaultModel }) => ({
    id,
    label,
    defaultModel,
    defaultBaseUrl: baseUrl,
    keysUrl: keysUrl ?? null,
    local: Boolean(local),
    /** A key for these must carry its own endpoint. */
    requiresBaseUrl: baseUrl === null
  }));
}
