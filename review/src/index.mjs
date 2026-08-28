/**
 * `review` — review a pull request as an agent that decides what to read.
 *
 * The shape is the other actions': `readInputs` is pure over an environment;
 * `run` takes inputs and runner context and drives `reviewPullRequest` over
 * the real io; `main` is the only place that touches process state. An event
 * that is not a `pull_request` is a red refusal here, exactly as a thread
 * that is neither issue nor pull request is in `triage`.
 */

import { readFileSync } from "node:fs";

import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
import { readSharedInputs } from "#core/inputs.mjs";
import {
  getBooleanInput,
  getNumberInput,
  getInput,
  info,
  isProgramEntry,
  maskSecret,
  readContext,
  setFailed,
} from "#core/runtime.mjs";

import { reviewPullRequest } from "./run.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */

export const ACTION = "review";

/**
 * @typedef {SharedInputs & { configPath: string, maxTurns: number, contextWindow: number, dryRun: boolean }} Inputs
 */

/**
 * @param {Env} [env]
 * @returns {Inputs}
 */
export function readInputs(env = process.env) {
  return {
    ...readSharedInputs(env),
    // Read and validated here so the manifest's promise and the code agree.
    configPath: getInput("config-path", {}, env),
    maxTurns: getNumberInput("max-turns", { default: 30, min: 1 }, env),
    contextWindow: getNumberInput("context-window", { default: 128_000, min: 1_000 }, env),
    dryRun: getBooleanInput("dry-run", { default: false }, env),
  };
}

/**
 * The pull_request activity types this action answers to — the same set the
 * shipped workflow's `types:` filter declares. The filter is a convenience,
 * not the enforcement: a calling workflow with no `types:` filter, or a
 * wrong one, cannot widen the set, because `readEvent` re-checks the
 * payload's `action` field against this constant. No input adds a type
 * to it.
 *
 * @type {readonly string[]}
 */
export const PULL_REQUEST_ACTIVITY_TYPES = Object.freeze([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/**
 * The event this action answers to, read once from the runner-provided
 * payload file. Any other event name — or any payload activity type outside
 * the declared set, or none at all — is a refusal, not a silent success.
 *
 * @param {string} eventName
 * @param {string} eventPath
 * @returns {{ eventName: string, pullRequestNumber: number }}
 */
export function readEvent(eventName, eventPath) {
  if (eventName !== "pull_request") {
    throw new Error(
      `review runs on 'pull_request' events only — this run was triggered by '${eventName}'`,
    );
  }
  let event;
  try {
    // Read synchronously so callers stay testable over literal values.
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `the workflow event could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const action = /** @type {Record<string, unknown>} */ (event)["action"];
  if (typeof action !== "string" || !PULL_REQUEST_ACTIVITY_TYPES.includes(action)) {
    const declared = PULL_REQUEST_ACTIVITY_TYPES.map((type) => `'${type}'`).join(", ");
    const carries = typeof action === "string" ? `'${action}'` : "none";
    throw new Error(
      `review runs on pull_request activity types ${declared} only — this event carries ${carries}`,
    );
  }
  const number = /** @type {Record<string, unknown>} */ (event)["pull_request"];
  const pull = /** @type {Record<string, unknown> | undefined} */ (
    typeof number === "object" && number !== null ? number : undefined
  );
  const pullNumber = pull?.["number"];
  if (typeof pullNumber !== "number") {
    throw new Error("the event carries no pull_request.number — nothing to review");
  }
  return { eventName, pullRequestNumber: pullNumber };
}

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Partial<import("./run.mjs").Io>} [io] injectable for tests; real clients otherwise
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io = {}) {
  const event = readEvent(context.eventName, /** @type {string} */ (context.eventPath));
  const result = await reviewPullRequest({
    inputs: {
      model: inputs.model,
      maxTurns: inputs.maxTurns,
      contextWindow: inputs.contextWindow,
      dryRun: inputs.dryRun,
      configPath: inputs.configPath,
    },
    context: { owner: context.owner, repo: context.repo, workspace: context.workspace },
    pullRequestNumber: event.pullRequestNumber,
    io: {
      forge:
        io.forge ??
        createForge({
          owner: context.owner,
          repo: context.repo,
          token: inputs.githubToken,
          apiUrl: context.apiUrl,
        }),
      chat: io.chat ?? createChat({ apiUrl: inputs.apiUrl, apiKey: inputs.apiKey }),
      now: io.now ?? (() => Date.now()),
      info: io.info ?? ((message) => info(message)),
    },
  });
  const log = io.info ?? ((message) => info(message));
  log(`review: ${result.reason}`);
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
