/**
 * `review` — review a pull request as an agent that decides what to read.
 *
 * The shape is the other actions': `readInputs` is pure over an environment;
 * `run` takes inputs and runner context and drives `reviewPullRequest` over
 * the real io; `main` is the only place that touches process state. An event
 * that is not a `pull_request` is a refusal here, exactly as a thread that
 * is neither issue nor pull request is in `triage` — review produces, GitHub
 * disposes (ADR 006), so a `merge_group` event is an unsupported event, not
 * a review subject, and it reaches no write.
 *
 * `run` is also the red boundary (#355), the twin of harmonise's (#347): a
 * throw out of `reviewPullRequest` still leaves the run's one artifact —
 * `refused` for a typed deterministic refusal, `failed` otherwise — before
 * the original error fails the step.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import * as p from "node:path";

import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
import { readSharedInputs } from "#core/inputs.mjs";
import { oneLine } from "#core/one-line.mjs";
import { sanitiseCommentText } from "#core/sanitise.mjs";
import {
  getBooleanInput,
  getNumberInput,
  getInput,
  info,
  isProgramEntry,
  maskSecret,
  readContext,
  setFailed,
  setOutput,
} from "#core/runtime.mjs";

import { reviewPullRequest } from "./run.mjs";
import { buildRedArtifact, RED_REASON_CHARS, serialiseArtifact } from "./artifact.mjs";
import { toSarif } from "./sarif.mjs";
import { DeterministicRefusalError } from "./refusal.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */

export const ACTION = "review";

/**
 * The one event name the entrypoint accepts. `readEvent` throws on any other
 * — `merge_group` included (ADR 006) — a red refusal that writes nothing, and
 * no input widens the set. Exported as the truth the event-parity gate
 * (tools/event-parity.mjs) holds every declared surface to; the throw is the
 * runtime's own enforcement of the same set.
 *
 * @type {readonly string[]}
 */
export const ACCEPTED_EVENTS = Object.freeze(["pull_request"]);

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
 * The event facts a pull_request run carries.
 *
 * @typedef {object} PullRequestEventFacts
 * @property {"pull_request"} eventName
 * @property {number} pullRequestNumber
 * @property {Record<string, unknown>} event
 */

/**
 * The one event this action answers to, read once from the runner-provided
 * payload file: `pull_request`, one review per pull request. Any other
 * event name — `merge_group` included (ADR 006: review does not run for
 * merge groups) — or any pull_request payload activity type outside the
 * declared set, or none at all, is a refusal, not a silent success.
 *
 * @param {string} eventName
 * @param {string} eventPath
 * @returns {PullRequestEventFacts}
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
  const log = io.info ?? ((message) => info(message));
  // One forge client for the whole entrypoint — the run's writes and the
  // entrypoint's own post-run write below share it, never a second one.
  const forge =
    io.forge ??
    createForge({
      owner: context.owner,
      repo: context.repo,
      token: inputs.githubToken,
      apiUrl: context.apiUrl,
    });
  // The red-run facts the orchestrator stashes as it lands them; a `null`
  // head is the honest "died before the snapshot read" (#355).
  /** @type {import("./run.mjs").ReviewRedFacts} */
  const red = { headRef: null };
  let result;
  try {
    result = await reviewPullRequest({
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
        forge,
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
      red,
    });
  } catch (cause) {
    // The red boundary (#355): a run that ends red before its own write
    // site still leaves its one artifact — `refused` when the throw carries
    // the typed deterministic-refusal class (the run's own ceilings
    // declining to act: the diff-line budget, the prompt-headroom ceiling,
    // the output contract, the config validator, the posture-document
    // guard), `failed` for every other undeclared throw — and the original
    // error still fails the step; the record never masks the throw it
    // records. A failure of this artifact write itself is a logged loss,
    // never a replacement error (F-14: the write site's tier, not the
    // boundary's). The event read above this try is the carve-out — a
    // death before the run holds the facts an artifact is built from
    // stays unrecorded.
    const classification = cause instanceof DeterministicRefusalError ? "refused" : "failed";
    const reason = redReason(cause, log);
    try {
      const artifact = buildRedArtifact({
        repository: `${context.owner}/${context.repo}`,
        pullRequest: event.pullRequestNumber,
        headRef: red.headRef,
        outcome: classification,
        reason,
        ...(red.commentId !== undefined ? { commentId: red.commentId } : {}),
        ...(red.applicability !== undefined ? { applicability: red.applicability } : {}),
      });
      const file = writeRunArtifact({
        workspace: context.workspace,
        directory: inputs.artifactPath,
        artifact,
      });
      // The boundary's record is a declared write: it publishes the same
      // fact a green run publishes — #378's failed-run reporter names its
      // file, and a lost record's absence stays loud in the catch below.
      setOutput("artifact-file", file);
      log(`review: ${classification} run artifact written to ${file}`);
    } catch (recordCause) {
      log(
        `review: the ${classification} run's artifact was not written: ` +
          `${recordCause instanceof Error ? recordCause.message : String(recordCause)}`,
      );
    }
    throw cause;
  }
  log(`review: ${result.reason}`);

  if (result.artifact !== undefined) {
    try {
      const file = writeRunArtifact({
        workspace: context.workspace,
        directory: inputs.artifactPath,
        artifact: result.artifact,
      });
      // The publish posture's one machine-readable fact (#378): the exact
      // file this run wrote, as the runner reads it.
      setOutput("artifact-file", file);
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
  } else {
    // The posture's no-false-alarm half (#378): a terminal that declares
    // no record says so, so a missing `artifact-file` output reads as
    // "declared nothing" and never as an unlogged loss.
    log("review: artifact publish — this terminal declared no run artifact");
  }

  // ── Post-run projection: the SARIF file, the one job output review adds ──
  // Only a published run has a canonical record. The SARIF write is a logged
  // loss on its own failure (F-14 posture for a write site that is not the
  // run's record): the review's verdict stands on the comment and the
  // artifact; a SARIF file that could not be written is reported, never
  // disguised as success, and never replaces the verdict. There is no
  // gate-verdict output and no check run — merge enforcement is the
  // consumer's ruleset over Code Scanning (ADR 006), never this action.
  if (result.canonical !== undefined) {
    try {
      const sarifPath = writeSarifFile({
        tempDir: context.runnerTemp,
        canonical: result.canonical,
      });
      setOutput("sarif-path", sarifPath);
    } catch (cause) {
      log(
        `review: the SARIF projection was not written: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return result;
}

/**
 * Writes the review's SARIF projection under the runner's temp directory —
 * never inside the workspace, which the checkout owns and a later step may
 * `git clean`. The bytes are exactly `JSON.stringify(toSarif(canonical))`:
 * no timestamps, no run id, so two projections of the same canonical record
 * are byte-identical and a diff of two runs is a diff of verdicts.
 *
 * @param {object} input
 * @param {string | undefined} input.tempDir the runner's `RUNNER_TEMP`
 * @param {import("./canonical.mjs").CanonicalResult} input.canonical
 * @returns {string} the written file's path
 */
export function writeSarifFile({ tempDir, canonical }) {
  if (tempDir === undefined || tempDir === "") {
    throw new Error(
      "RUNNER_TEMP is not set — the SARIF projection has nowhere runner-scoped to land",
    );
  }
  const file = p.join(realpathSync(tempDir), `review-sarif-${canonical.head}.json`);
  writeFileSync(file, JSON.stringify(toSarif(canonical)), "utf8");
  return file;
}

/**
 * The red artifact's reason: the thrown error's own sentence, flattened to
 * one line with control characters mapped to spaces — a thrown message can
 * interpolate a pull-request author's file name, and escaped terminal
 * sequences must not ride into the record — then passed through the comment
 * sanitiser under the red record's declared cap. It is the one review
 * reason that interpolates a thrown message, so it enters the record only
 * through the sanitiser (I14, I16), the same posture harmonise's red
 * record keeps. The sanitiser's notes go to the run log, exactly where the
 * comment builders' notes go. A message that sanitises to nothing — empty,
 * whitespace, nothing but structural tokens — falls back to a fixed
 * sentence: the builder refuses an empty reason, and an unrecordable
 * reason must not cost the run its record.
 *
 * @param {unknown} cause what the run threw
 * @param {(message: string) => void} log the run's log sink
 * @returns {string}
 */
function redReason(cause, log) {
  const sentence = cause instanceof Error ? cause.message : String(cause);
  const result = sanitiseCommentText(oneLine(sentence, { stripControlChars: true }), {
    maxChars: RED_REASON_CHARS,
  });
  for (const note of result.notes) {
    log(`review: sanitiser: ${note}`);
  }
  return result.text === "" ? "the run failed without a message" : result.text;
}

/**
 * Writes the serialised run artifact inside the workspace, under a
 * deterministic name derived from the reviewed head. The ceiling is the
 * same one every read honours, pointed the other way: the path resolves
 * inside `GITHUB_WORKSPACE` or the run fails loudly — a symlinked branch of
 * the tree cannot carry the write out, and `.git` is refused outright,
 * because that is where the checkout's credential lives. Containment comes
 * before mutation: every existing segment is lstat'd and a symlinked
 * segment refused before the write creates, clears, or serialises anything
 * against the path.
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
  // Containment before mutation: every segment that already exists is
  // lstat'd, and a symlinked segment is refused before the write mutates
  // anything — a planted link can neither carry the recursive mkdir outside
  // the workspace nor turn the namespace cleanup into an outside deletion.
  // A missing segment is fine: the mkdir below creates it, inside the root
  // the checks above pinned.
  let walked = root;
  for (const segment of p.relative(root, target).split(p.sep)) {
    walked = p.join(walked, segment);
    let stats;
    try {
      stats = lstatSync(walked);
    } catch {
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`artifact-path '${directory}' traverses the symlink '${segment}' — refused`);
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `artifact-path '${directory}' needs '${segment}' to be a directory — refused`,
      );
    }
  }
  mkdirSync(target, { recursive: true });
  // The walk above is static. A segment can be swapped for a symlink after
  // it and before the mkdir — the race the lstat walk cannot see — so the
  // real location is resolved and held to the same ceiling and the same
  // .git rule before the namespace cleanup and a single byte are written.
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(root + p.sep)) {
    throw new Error(`artifact-path '${directory}' resolves outside the workspace — refused`);
  }
  for (const segment of p.relative(root, real).split(p.sep)) {
    if (segment.toLowerCase() === ".git") {
      throw new Error(`artifact-path '${directory}' resolves inside .git — refused`);
    }
  }
  // Clear any previously-written file matching the upload glob inside the
  // validated target directory. A PR-author-writable checkout can plant a
  // file under a matching name; the run clears its own namespace before
  // writing, so a planted file cannot ride the `review-artifact-*.json`
  // upload glob on a path the action itself wrote nothing to. The glob is
  // deliberately narrow (`if-no-files-found: ignore`), but clearing at
  // write time removes the planted file even when the run ends on a path
  // that writes no artifact. The cleanup runs only here — after the path
  // is validated — never through an unvalidated link.
  for (const old of readdirSync(real)) {
    if (/^review-artifact-.*\.json$/u.test(old)) {
      rmSync(p.join(real, old), { force: true });
    }
  }
  // Every shape's file name names its outcome: a skip (through its `kind`,
  // or its `skip` classification when the record is kind-less), an
  // abandonment, a dry run, and the red terminals' refused/failed records
  // each get their own prefix, so a consumer reads the outcome before
  // opening the file. All names sit inside the upload glob
  // `review-artifact-*.json`; a red run that died before the snapshot read
  // has no head to name, and writes `no-head` in its place — one
  // deterministic name that never collides with a pinned run's 40 hex.
  const classification = /** @type {Record<string, unknown>} */ (artifact.outcome).classification;
  const prefix =
    "kind" in artifact || classification === "skip"
      ? "review-artifact-skip"
      : classification === "abandoned"
        ? "review-artifact-abandoned"
        : classification === "dry-run"
          ? "review-artifact-dry-run"
          : classification === "refused"
            ? "review-artifact-refused"
            : classification === "failed"
              ? "review-artifact-failed"
              : "review-artifact";
  const name = `${prefix}-${artifact.headRef ?? "no-head"}.json`;
  const file = p.join(real, name);
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
