/**
 * Token prices, used to turn recorded usage into money.
 *
 * There is no built-in price table on purpose. Provider pricing changes often
 * and silently, and a stale hard-coded number is worse than no number: it would
 * quietly mis-bill every estimate and drive the "lowest-cost" routing strategy
 * to the wrong key. So cost is only ever reported for models the operator has
 * priced, and reads as `null` otherwise — tokens are always recorded either way.
 *
 * Configure with AI_PRICING_JSON, keyed `provider:model`, in micro-USD per
 * million tokens (so 3_000_000 = $3.00 / Mtok):
 *
 *   AI_PRICING_JSON={"openai:gpt-x":{"in":2500000,"out":10000000}}
 */

export type ModelPrice = { in: number; out: number };

let cache: { raw: string | undefined; table: Record<string, ModelPrice> } | null = null;

function table(): Record<string, ModelPrice> {
  const raw = process.env.AI_PRICING_JSON;
  if (cache && cache.raw === raw) return cache.table;

  let parsed: Record<string, ModelPrice> = {};
  if (raw) {
    try {
      const candidate = JSON.parse(raw) as Record<string, ModelPrice>;
      // A malformed entry must not poison the whole table.
      for (const [key, value] of Object.entries(candidate)) {
        if (value && typeof value.in === "number" && typeof value.out === "number") {
          parsed[key] = { in: value.in, out: value.out };
        }
      }
    } catch {
      console.warn("[ai/pricing] AI_PRICING_JSON is not valid JSON — costs will report as unknown.");
      parsed = {};
    }
  }

  cache = { raw, table: parsed };
  return parsed;
}

export function priceFor(provider: string, model: string): ModelPrice | null {
  return table()[`${provider}:${model}`] ?? null;
}

/**
 * Cost in micro-USD, or null when the model has no configured price.
 * Null is a real answer here — it means "not known", not "free".
 */
export function costMicros(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const price = priceFor(provider, model);
  if (!price) return null;
  return Math.round((promptTokens * price.in + completionTokens * price.out) / 1_000_000);
}

/** Rough pre-flight estimate. Output length is unknown before the call, so the
 *  caller supplies its own ceiling — usually maxTokens. */
export function estimateMicros(
  provider: string,
  model: string,
  promptTokens: number,
  expectedCompletionTokens: number
): number | null {
  return costMicros(provider, model, promptTokens, expectedCompletionTokens);
}

/** ~4 characters per token is close enough to size a prompt before sending it. */
export function approxTokens(text: string) {
  return Math.ceil(text.length / 4);
}
