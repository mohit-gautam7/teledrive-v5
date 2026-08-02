/**
 * Feature flags, read from the environment at call time.
 *
 * The AI platform ships dark: every route and worker below checks these, so the
 * code can land, be deployed and be reviewed without changing what the app does
 * for anyone. Read per call rather than captured at module load so a flag can be
 * flipped by restarting the process, with no rebuild.
 */

const on = (value: string | undefined) => value === "1" || value === "true";

/** Master switch for the AI platform: vault, router, providers, AI routes. */
export function aiEnabled() {
  return on(process.env.AI_ENABLED);
}

/**
 * Whether this process should drain the background job queue.
 *
 * Deliberately separate from `aiEnabled`: a serverless deployment can accept and
 * enqueue jobs while only the always-on host actually runs them.
 */
export function jobWorkerEnabled() {
  return on(process.env.JOB_WORKER_ENABLED);
}
