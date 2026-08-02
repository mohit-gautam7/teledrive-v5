import { prisma } from "@/lib/prisma";
import { chat, embed, transcribe, ProviderError, type ChatMessage, type ChatResult } from "@/lib/ai/client";
import { revealKey } from "@/lib/ai/vault";
import { costMicros, estimateMicros, approxTokens, priceFor } from "@/lib/ai/pricing";

/**
 * Picks which key runs a request, and keeps trying down the list when one fails.
 *
 * The user may hold many keys across many providers. The router turns that into
 * a single call: choose an order, try each in turn, record what happened, and
 * take a key out of rotation when it is clearly broken rather than failing every
 * request against it.
 */

export type RotationStrategy = "priority" | "round-robin" | "least-used" | "lowest-cost" | "fastest";

/** Consecutive failures before a key is parked. A credential rejection skips
 *  straight to disabled — retrying a wrong key never helps. */
const FAILURE_LIMIT = 5;

export type RunOptions = {
  userId: string;
  task: string;
  messages: ChatMessage[];
  /** Restrict to these providers, in preference order. Empty means any. */
  providers?: string[];
  strategy?: RotationStrategy;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Offline mode: only the user's own machine may answer. */
  localOnly?: boolean;
  /** Free mode: only keys that provably cost nothing. An unpriced key is not
   *  free — its price is merely unknown — so it is excluded. */
  freeOnly?: boolean;
};

export type RunResult = ChatResult & {
  provider: string;
  model: string;
  keyId: string;
  latencyMs: number;
  costMicros: number | null;
};

type Candidate = {
  id: string;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  priority: number;
  lastUsedAt: Date | null;
  dailyLimitMicros: bigint | null;
};

const startOfUtcDay = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** Spend per key so far today, for limit checks and least-used ordering. */
async function todaySpend(keyIds: string[]) {
  if (!keyIds.length) return new Map<string, { micros: bigint; calls: number }>();
  const rows = await prisma.aiUsage.groupBy({
    by: ["keyId"],
    where: { keyId: { in: keyIds }, createdAt: { gte: startOfUtcDay() } },
    _sum: { costMicros: true },
    _count: { _all: true }
  });
  return new Map(
    rows.map(r => [r.keyId as string, { micros: r._sum.costMicros ?? BigInt(0), calls: r._count._all }])
  );
}

/** Mean latency of each key's recent successful calls, for "fastest". */
async function recentLatency(keyIds: string[]) {
  if (!keyIds.length) return new Map<string, number>();
  const rows = await prisma.aiUsage.groupBy({
    by: ["keyId"],
    where: { keyId: { in: keyIds }, status: "ok" },
    _avg: { latencyMs: true }
  });
  return new Map(rows.map(r => [r.keyId as string, r._avg.latencyMs ?? Number.MAX_SAFE_INTEGER]));
}

async function orderCandidates(
  candidates: Candidate[],
  strategy: RotationStrategy,
  spend: Map<string, { micros: bigint; calls: number }>
): Promise<Candidate[]> {
  const list = [...candidates];

  switch (strategy) {
    case "round-robin":
      // Least recently used first; a key never used goes to the front.
      return list.sort(
        (a, b) => (a.lastUsedAt?.getTime() ?? 0) - (b.lastUsedAt?.getTime() ?? 0)
      );

    case "least-used":
      return list.sort(
        (a, b) => (spend.get(a.id)?.calls ?? 0) - (spend.get(b.id)?.calls ?? 0)
      );

    case "lowest-cost": {
      // Output price is the dominant term for generation. Keys with no
      // configured price sort last: unknown is not a licence to assume free.
      const rank = (c: Candidate) => {
        const p = c.model ? priceFor(c.provider, c.model) : null;
        return p ? p.out : Number.MAX_SAFE_INTEGER;
      };
      return list.sort((a, b) => rank(a) - rank(b));
    }

    case "fastest": {
      const latency = await recentLatency(list.map(c => c.id));
      // An unmeasured key sorts first so it gets the one call it needs to earn
      // a real number, instead of never being chosen.
      const rank = (c: Candidate) => latency.get(c.id) ?? -1;
      return list.sort((a, b) => rank(a) - rank(b));
    }

    case "priority":
    default:
      return list.sort((a, b) => a.priority - b.priority);
  }
}

async function recordUsage(opts: {
  userId: string;
  keyId: string;
  provider: string;
  model: string;
  task: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: "ok" | "error";
  error?: string;
}) {
  const cost =
    opts.status === "ok"
      ? costMicros(opts.provider, opts.model, opts.promptTokens, opts.completionTokens)
      : null;

  // Metering must never take down the call it is measuring.
  await prisma.aiUsage
    .create({
      data: {
        userId: opts.userId,
        keyId: opts.keyId,
        provider: opts.provider,
        model: opts.model,
        task: opts.task,
        promptTokens: opts.promptTokens,
        completionTokens: opts.completionTokens,
        costMicros: cost === null ? null : BigInt(cost),
        latencyMs: opts.latencyMs,
        status: opts.status,
        error: opts.error?.slice(0, 500)
      }
    })
    .catch(err => console.warn("[ai/router] could not record usage:", (err as Error).message));

  return cost;
}

async function noteFailure(keyId: string, error: ProviderError) {
  // A rejected credential is terminal for this key; anything else is counted and
  // only parks the key once it keeps happening.
  if (error.credentialFailure) {
    await prisma.aiKey
      .update({
        where: { id: keyId },
        data: {
          enabled: false,
          health: "disabled",
          lastError: error.message.slice(0, 500),
          disabledAt: new Date()
        }
      })
      .catch(() => {});
    return;
  }

  const updated = await prisma.aiKey
    .update({
      where: { id: keyId },
      data: { failureCount: { increment: 1 }, health: "failing", lastError: error.message.slice(0, 500) },
      select: { failureCount: true }
    })
    .catch(() => null);

  if (updated && updated.failureCount >= FAILURE_LIMIT) {
    await prisma.aiKey
      .update({ where: { id: keyId }, data: { enabled: false, health: "disabled", disabledAt: new Date() } })
      .catch(() => {});
  }
}

async function noteSuccess(keyId: string) {
  await prisma.aiKey
    .update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(), health: "ok", failureCount: 0, lastError: null }
    })
    .catch(() => {});
}

async function candidatesFor(userId: string, providers?: string[]): Promise<Candidate[]> {
  return prisma.aiKey.findMany({
    where: {
      userId,
      enabled: true,
      ...(providers?.length ? { provider: { in: providers } } : {})
    },
    select: {
      id: true,
      provider: true,
      model: true,
      baseUrl: true,
      priority: true,
      lastUsedAt: true,
      dailyLimitMicros: true
    }
  });
}

/**
 * Whether a key satisfies the mode's constraints.
 *
 * "Free" deliberately requires a *known* zero price. Treating an unpriced model
 * as free is how a free mode quietly spends money.
 */
function modeAllows(c: Candidate, opts: Pick<RunOptions, "localOnly" | "freeOnly">) {
  if (opts.localOnly && c.provider !== "local") return false;
  if (opts.freeOnly) {
    if (c.provider === "local") return true;
    const price = c.model ? priceFor(c.provider, c.model) : null;
    return price !== null && price.in === 0 && price.out === 0;
  }
  return true;
}

export class NoKeyAvailableError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "NoKeyAvailableError";
  }
}

/**
 * What this request would cost on each usable key, before running it.
 * `micros: null` means the model has no configured price — see lib/ai/pricing.
 */
export async function estimate(opts: Omit<RunOptions, "signal">) {
  const promptTokens = approxTokens(opts.messages.map(m => m.content).join("\n"));
  const expected = opts.maxTokens ?? 1024;
  const candidates = await candidatesFor(opts.userId, opts.providers);

  return candidates
    .filter(c => c.model)
    .map(c => ({
      keyId: c.id,
      provider: c.provider,
      model: c.model as string,
      promptTokens,
      expectedCompletionTokens: expected,
      micros: estimateMicros(c.provider, c.model as string, promptTokens, expected)
    }));
}

/**
 * Run a prompt against the user's keys, walking the fallback chain until one
 * succeeds. Throws only when every candidate has been tried.
 */
/** Constraints shared by every kind of call the router can make. */
type SelectOptions = Pick<
  RunOptions,
  "userId" | "providers" | "strategy" | "localOnly" | "freeOnly"
>;

/** The keys that may serve this request, best first. */
async function orderedUsable(opts: SelectOptions) {
  const candidates = await candidatesFor(opts.userId, opts.providers);
  if (!candidates.length) {
    throw new NoKeyAvailableError("No enabled AI key. Add one in Settings to use this feature.");
  }

  const spend = await todaySpend(candidates.map(c => c.id));

  const eligible = candidates.filter(c => modeAllows(c, opts));
  if (!eligible.length) {
    throw new NoKeyAvailableError(
      opts.localOnly
        ? "Offline mode only uses local keys, and you have none enabled. Add a Local key in Settings."
        : opts.freeOnly
          ? "Free mode only uses keys that cost nothing — a local key, or one priced at 0 in AI_PRICING_JSON."
          : "No enabled AI key matches this mode."
    );
  }

  const usable = eligible.filter(c => {
    if (!c.model) return false;
    if (c.dailyLimitMicros === null) return true;
    return (spend.get(c.id)?.micros ?? BigInt(0)) < c.dailyLimitMicros;
  });
  if (!usable.length) {
    throw new NoKeyAvailableError(
      "Every AI key is either missing a model or has hit its daily limit. Raise a limit or add another key."
    );
  }

  return orderCandidates(usable, opts.strategy ?? "priority", spend);
}

/**
 * Walk the fallback chain, recording usage and health for each attempt.
 *
 * Chat, embeddings and transcription differ only in the call they make, so the
 * selection, retry, metering and auto-disable logic lives here once rather than
 * being reimplemented — and drifting — three times.
 */
async function attempt<T>(
  opts: SelectOptions & { task: string; signal?: AbortSignal },
  call: (ctx: { provider: string; apiKey: string; baseUrl: string | null; model: string }) => Promise<{
    value: T;
    promptTokens: number;
    completionTokens: number;
  }>
): Promise<{ value: T; provider: string; model: string; keyId: string; latencyMs: number; costMicros: number | null }> {
  const ordered = await orderedUsable(opts);

  let lastError: Error | null = null;
  for (const candidate of ordered) {
    const apiKey = await revealKey(opts.userId, candidate.id);
    if (!apiKey) continue;

    const model = candidate.model as string;
    const started = Date.now();
    try {
      const out = await call({ provider: candidate.provider, apiKey, baseUrl: candidate.baseUrl, model });
      const latencyMs = Date.now() - started;

      const cost = await recordUsage({
        userId: opts.userId,
        keyId: candidate.id,
        provider: candidate.provider,
        model,
        task: opts.task,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        latencyMs,
        status: "ok"
      });
      await noteSuccess(candidate.id);

      return { value: out.value, provider: candidate.provider, model, keyId: candidate.id, latencyMs, costMicros: cost };
    } catch (err) {
      const error = err instanceof ProviderError ? err : new ProviderError((err as Error).message, 0);
      lastError = error;

      await recordUsage({
        userId: opts.userId,
        keyId: candidate.id,
        provider: candidate.provider,
        model,
        task: opts.task,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - started,
        status: "error",
        error: error.message
      });
      await noteFailure(candidate.id, error);

      // A caller-cancelled request is not a provider fault — stop, do not fall
      // through to every other key.
      if (opts.signal?.aborted) throw error;
    }
  }

  throw lastError ?? new NoKeyAvailableError("No AI key could serve this request.");
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const out = await attempt<ChatResult>(opts, async ctx => {
    const result = await chat(ctx.provider, ctx.apiKey, ctx.baseUrl, {
      messages: opts.messages,
      model: ctx.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      signal: opts.signal
    });
    return { value: result, promptTokens: result.promptTokens, completionTokens: result.completionTokens };
  });

  return {
    ...out.value,
    provider: out.provider,
    model: out.model,
    keyId: out.keyId,
    latencyMs: out.latencyMs,
    costMicros: out.costMicros
  };
}

/** Speech to text, through the same key selection and metering as chat. */
export async function runTranscribe(
  opts: SelectOptions & {
    task: string;
    audio: { bytes: Buffer; filename: string; mimeType: string };
    signal?: AbortSignal;
  }
) {
  const out = await attempt<string>(opts, async ctx => {
    const result = await transcribe(ctx.provider, ctx.apiKey, ctx.baseUrl, ctx.model, opts.audio, opts.signal);
    // Transcription endpoints do not report token usage; the duration is what
    // costs money, and providers price that separately.
    return { value: result.text, promptTokens: 0, completionTokens: 0 };
  });
  return { text: out.value, provider: out.provider, model: out.model, latencyMs: out.latencyMs };
}

/** Embeddings, through the same key selection and metering as chat. */
export async function runEmbed(
  opts: SelectOptions & { task: string; inputs: string[]; signal?: AbortSignal }
) {
  const out = await attempt<number[][]>(opts, async ctx => {
    const result = await embed(ctx.provider, ctx.apiKey, ctx.baseUrl, ctx.model, opts.inputs, opts.signal);
    return { value: result.vectors, promptTokens: result.promptTokens, completionTokens: 0 };
  });
  return { vectors: out.value, provider: out.provider, model: out.model, costMicros: out.costMicros };
}
