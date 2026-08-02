import { prisma } from "@/lib/prisma";
import type { RotationStrategy } from "@/lib/ai/router";

/**
 * AI modes: a short name for "which of my keys should answer this, and in what
 * order", so a user picks an intent instead of hand-wiring providers per task.
 *
 * Each mode is defined against signals the app actually has — provider identity
 * and configured price — rather than a vague notion of quality:
 *
 *   offline  only the user's own machine (`local` provider). Nothing leaves it.
 *   free     zero-cost only: local keys, plus keys whose model is priced at 0.
 *            An *unpriced* hosted key is excluded, because unknown is not free.
 *   premium  every enabled key, best-first by the priority the user set.
 *   hybrid   every enabled key, cheapest-first, falling back up the chain.
 *   custom   the user's own provider list and strategy, per task.
 */

export const AI_MODES = ["free", "premium", "hybrid", "offline", "custom"] as const;
export type AiMode = (typeof AI_MODES)[number];

export function isAiMode(value: string): value is AiMode {
  return (AI_MODES as readonly string[]).includes(value);
}

/** Resolved instruction for one request. */
export type RoutingPlan = {
  mode: AiMode;
  strategy: RotationStrategy;
  /** Restrict to these providers. Undefined means "any enabled key". */
  providers?: string[];
  /** Only the `local` provider is eligible. */
  localOnly: boolean;
  /** Only keys that cost nothing are eligible. */
  freeOnly: boolean;
};

export type TaskOverride = {
  mode?: AiMode;
  providers?: string[];
  strategy?: RotationStrategy;
};

export type AiPreferences = {
  mode: AiMode;
  strategy: RotationStrategy;
  taskOverrides: Record<string, TaskOverride>;
};

export const DEFAULT_PREFERENCES: AiPreferences = {
  mode: "hybrid",
  strategy: "priority",
  taskOverrides: {}
};

const STRATEGIES: RotationStrategy[] = ["priority", "round-robin", "least-used", "lowest-cost", "fastest"];

function asStrategy(value: unknown, fallback: RotationStrategy): RotationStrategy {
  return typeof value === "string" && (STRATEGIES as string[]).includes(value)
    ? (value as RotationStrategy)
    : fallback;
}

/** Stored JSON is user-supplied; narrow it rather than trusting the column. */
function parseOverrides(raw: unknown): Record<string, TaskOverride> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TaskOverride> = {};
  for (const [task, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const override: TaskOverride = {};
    if (typeof v.mode === "string" && isAiMode(v.mode)) override.mode = v.mode;
    if (Array.isArray(v.providers)) override.providers = v.providers.filter((p): p is string => typeof p === "string");
    if (typeof v.strategy === "string") override.strategy = asStrategy(v.strategy, "priority");
    if (Object.keys(override).length) out[task] = override;
  }
  return out;
}

export async function readPreferences(userId: string): Promise<AiPreferences> {
  const row = await prisma.aiPreference.findUnique({ where: { userId } });
  if (!row) return DEFAULT_PREFERENCES;
  return {
    mode: isAiMode(row.mode) ? row.mode : DEFAULT_PREFERENCES.mode,
    strategy: asStrategy(row.strategy, DEFAULT_PREFERENCES.strategy),
    taskOverrides: parseOverrides(row.taskOverrides)
  };
}

export async function writePreferences(userId: string, next: AiPreferences) {
  return prisma.aiPreference.upsert({
    where: { userId },
    create: {
      userId,
      mode: next.mode,
      strategy: next.strategy,
      taskOverrides: next.taskOverrides as never
    },
    update: {
      mode: next.mode,
      strategy: next.strategy,
      taskOverrides: next.taskOverrides as never
    }
  });
}

/** Turn a mode into the constraints the router understands. */
function planFor(mode: AiMode, strategy: RotationStrategy, providers?: string[]): RoutingPlan {
  switch (mode) {
    case "offline":
      // Deliberately no `providers` filter: narrowing the candidate query to
      // ["local"] empties it before the mode filter runs, and the user gets a
      // generic "no key" error instead of "offline mode needs a local key".
      // `localOnly` enforces the same restriction one step later, where the
      // router can say why.
      return { mode, strategy, localOnly: true, freeOnly: false };
    case "free":
      // Cheapest-first is the natural order once everything eligible is free:
      // it still prefers a locally-priced 0 over an unpriced one.
      return { mode, strategy: "lowest-cost", localOnly: false, freeOnly: true };
    case "premium":
      return { mode, strategy: "priority", localOnly: false, freeOnly: false };
    case "hybrid":
      return { mode, strategy: "lowest-cost", localOnly: false, freeOnly: false };
    case "custom":
    default:
      return { mode: "custom", strategy, providers, localOnly: false, freeOnly: false };
  }
}

/**
 * The plan for one task, with a per-task override taking precedence over the
 * account-wide mode. An explicit request-level mode beats both — the caller
 * passes it when the user picked a mode for this one action.
 */
export async function resolvePlan(userId: string, task: string, requestedMode?: AiMode): Promise<RoutingPlan> {
  const prefs = await readPreferences(userId);
  const override = prefs.taskOverrides[task];

  const mode = requestedMode ?? override?.mode ?? prefs.mode;
  const strategy = override?.strategy ?? prefs.strategy;
  const providers = override?.providers?.length ? override.providers : undefined;

  return planFor(mode, strategy, providers);
}
