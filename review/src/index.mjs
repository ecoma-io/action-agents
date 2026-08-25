/**
 * `review` — review a pull request as an agent that decides what to read.
 *
 * SEED. The wiring is real and the policy is not written yet: inputs are read
 * and validated, the runner context is established, secrets are masked, and
 * `run` refuses loudly. Everything below the input layer is what the next
 * change fills in.
 *
 * The shape is deliberate. `readInputs` is pure over an environment, so what an
 * action accepts can be pinned by a test without a runner; `run` takes those
 * inputs as an argument rather than reading the world again; and `main` is the
 * only place that touches process state. An action that read `process.env`
 * three layers down would be one nobody could test offline.
 */

import { readSharedInputs } from "#core/inputs.mjs";
import {
  getBooleanInput,
  getInput,
  getNumberInput,
  info,
  isProgramEntry,
  maskSecret,
  readContext,
  setFailed,
} from "#core/runtime.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */

export const ACTION = "review";

/**
 * @typedef {SharedInputs & { configPath: string, instructionsPath: string, maxTurns: number, contextWindow: number, dryRun: boolean }} Inputs
 */

/**
 * @param {Env} [env]
 * @returns {Inputs}
 */
export function readInputs(env = process.env) {
  return {
    ...readSharedInputs(env),
    // Read and validated here so the manifest's promise and the code agree;
    // the reader that consumes it lands with review's implementation.
    configPath: getInput("config-path", {}, env),
    instructionsPath: getInput(
      "instructions-path",
      { default: ".github/review-instructions.md" },
      env,
    ),
    maxTurns: getNumberInput("max-turns", { default: 30, min: 1 }, env),
    contextWindow: getNumberInput("context-window", { default: 128_000, min: 1_000 }, env),
    dryRun: getBooleanInput("dry-run", { default: false }, env),
  };
}

/**
 * @param {Inputs} _inputs
 * @param {ReturnType<typeof readContext>} _context
 * @returns {Promise<void>}
 */
export async function run(_inputs, _context) {
  // Refusing is the honest state. An action that logged "nothing to do" here
  // would report success for work it never attempted, and a workflow would go
  // green on it every run.
  return Promise.reject(
    new Error(
      "review is not implemented yet — the action reads and validates its inputs, and does nothing else.",
    ),
  );
}

/**
 * @param {Env} [env]
 * @param {typeof run} [execute]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function main(env = process.env, execute = run) {
  try {
    const inputs = readInputs(env);
    // Before anything can print it, and before the first request is built.
    maskSecret(inputs.apiKey);
    const context = readContext(env);
    info(
      `review: ${context.owner}/${context.repo} on ${context.eventName}` +
        (inputs.dryRun ? " (dry run — nothing will be written)" : ""),
    );
    await execute(inputs, context);
    return { ok: true };
  } catch (cause) {
    setFailed(cause);
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

if (isProgramEntry(import.meta.url)) await main();
