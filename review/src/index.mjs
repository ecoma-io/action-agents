/**
 * `review` — review a pull request as an agent that decides what to read.
 *
 * The shape is the other actions': `readInputs` is pure over an environment;
 * `run` takes inputs and runner context and drives `reviewPullRequest` over
 * the real io; `main` is the only place that touches process state. An event
 * that is not a `pull_request` is a red refusal here, exactly as a thread
 * that is neither issue nor pull request is in `triage`.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

import * as p from "node:path";

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
import { serialiseArtifact } from "./artifact.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */

export const ACTION = "review";

/**
 * @typedef {SharedInputs & { configPath: string, maxTurns: number, contextWindow: number, requestTimeoutMs: number, dryRun: boolean, artifactPath: string }} Inputs
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
    // Where inside the workspace the run artifact lands. The default agrees
    // with the manifest; the write is confined below either way.
    artifactPath: getInput("artifact-path", { default: ".review-artifact" }, env),
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
 * @returns {{ eventName: string, pullRequestNumber: number, event: Record<string, unknown> }}
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
  return { eventName, pullRequestNumber: pullNumber, event };
}

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Partial<import("./run.mjs").Io> & { fetchImpl?: typeof globalThis.fetch }} [io] injectable for tests; real clients otherwise
 * @returns {Promise<import("./run.mjs").RunResult>}
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
    eventName: event.eventName,
    event: event.event,
    io: {
      forge:
        io.forge ??
        createForge({
          owner: context.owner,
          repo: context.repo,
          token: inputs.githubToken,
          apiUrl: context.apiUrl,
        }),
      chat:
        io.chat ??
        createChat({
          apiUrl: inputs.apiUrl,
          apiKey: inputs.apiKey,
          timeoutMs: inputs.requestTimeoutMs,
          ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
        }),
      now: io.now ?? (() => Date.now()),
      info: io.info ?? ((message) => info(message)),
    },
  });
  const log = io.info ?? ((message) => info(message));
  log(`review: ${result.reason}`);

  if (result.artifact !== undefined) {
    try {
      const file = writeRunArtifact({
        workspace: context.workspace,
        directory: inputs.artifactPath,
        artifact: result.artifact,
      });
      log(`review: run artifact written to ${file}`);
    } catch (cause) {
      // A skip's record is the skip's whole outcome — a failed write there
      // is a red run, never a silently unrecorded skip. A published run
      // keeps today's downgrade: the comment stands, the artifact is the loss.
      if (result.outcome !== "published") {
        throw cause;
      }
      result.outcome = "published-without-artifact";
      result.reason = `the comment is published but the run artifact was not written: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      log(`review: ${result.reason}`);
    }
  }
  return result;
}

/**
 * Writes the serialised run artifact inside the workspace, under a
 * deterministic name derived from the reviewed head. The ceiling is the
 * same one every read honours, pointed the other way: the path resolves
 * inside `GITHUB_WORKSPACE` or the run fails loudly — a symlinked branch of
 * the tree cannot carry the write out, and `.git` is refused outright,
 * because that is where the checkout's credential lives.
 *
 * @param {object} input
 * @param {string} input.workspace the runner's workspace root
 * @param {string} input.directory the artifact-path input, relative to the root
 * @param {import("./artifact.mjs").AnyRunArtifact} input.artifact the run's machine-readable record
 * @returns {string} the file the artifact was written to
 */
export function writeRunArtifact({ workspace, directory, artifact }) {
  const root = realpathSync(workspace);
  const target = p.resolve(root, directory);
  if (target !== root && !target.startsWith(root + p.sep)) {
    throw new Error(`artifact-path '${directory}' resolves outside the workspace — refused`);
  }
  for (const segment of p.relative(root, target).split(p.sep)) {
    // Case-insensitive: the hosting filesystem may capitalise the directory
    // (.Git, .GIT), and the checkout's credential still lives there.
    if (segment.toLowerCase() === ".git") {
      throw new Error(`artifact-path '${directory}' touches .git — refused`);
    }
  }
  mkdirSync(target, { recursive: true });
  // A directory on the way may be a symlink pointing outside the workspace
  // or into the git metadata; resolve the real location and hold it to the
  // same ceiling and the same .git rule before a single byte is written.
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(root + p.sep)) {
    throw new Error(`artifact-path '${directory}' resolves outside the workspace — refused`);
  }
  for (const segment of p.relative(root, real).split(p.sep)) {
    if (segment.toLowerCase() === ".git") {
      throw new Error(`artifact-path '${directory}' resolves inside .git — refused`);
    }
  }
  const file = p.join(real, `review-artifact-${artifact.headRef}.json`);
  writeFileSync(file, serialiseArtifact(artifact), "utf8");
  return file;
}

/**
 * @param {Env} [env]
 * @param {(inputs: Inputs, context: ReturnType<typeof readContext>) => Promise<import("./run.mjs").RunResult | void>} [execute]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function main(env = process.env, execute = run) {
  try {
    const inputs = readInputs(env);
    // Before anything can print it, and before the first request is built.
    maskSecret(inputs.apiKey);
    maskSecret(inputs.githubToken);
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
