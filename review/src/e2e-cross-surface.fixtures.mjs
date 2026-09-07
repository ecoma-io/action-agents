/**
 * The one harness the PR9 cross-surface suites replay over. A case names a
 * scenario and a gate mode; the harness drives the action's real entrypoint
 * through it once and collects every surface the run touched — the run
 * result, the comment writes and deletions, the check run, the SARIF file,
 * the workspace artifact and the runner's outputs — so a test can assert
 * that no surface contradicts another. It also mints the deterministic
 * replay fingerprint the race suites (T18) compare: a schedule's whole
 * terminal effect, normalised only where a run legitimately varies (the
 * run-scoped marker id the upsert mints, the runner's temp paths).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { driveEntrypoint } from "./e2e.fixtures.mjs";
/** A forge stub with the deletion half of the upsert outcome recorded too. */
/** @typedef {import("./e2e.fixtures.mjs").RecordingForge & { deletes?: number[] }} RecordingForge */

/** A drive-ready scenario: the world a replay runs over, nothing else. */
/** @typedef {{
 *   workspace: string,
 *   forge: RecordingForge,
 *   chat: import("#core/chat.mjs").Chat & { calls?: () => number },
 *   extra?: Record<string, string>,
 * }} Scenario */

/**
 * A forge that records every comment deletion beside the writes forgeStub
 * already records. The duplicate-cleanup arm of the upsert keeps exactly
 * one comment by deleting the losers, and the concurrent-run guard must
 * delete nothing at all — a race assertion that cannot see deletions
 * cannot tell "kept one" from "kept the thread as found".
 *
 * @param {import("./e2e.fixtures.mjs").RecordingForge} forge
 * @returns {RecordingForge}
 */
export function recordingDeletes(forge) {
  /** @type {number[]} */
  const deletes = [];
  return {
    ...forge,
    deletes,
    deleteComment: async (/** @type {number} */ id) => {
      deletes.push(id);
      return forge.deleteComment(id);
    },
  };
}

/**
 * The workspace artifacts a run wrote — `[]` when it declared none, so the
 * carve-out row reads the same way a no-write terminal does: as facts about
 * the disk, never as assumptions.
 *
 * @param {string} workspace
 * @returns {Array<{ name: string, json: any }>}
 */
export function artifactsOf(workspace) {
  try {
    return readdirSync(join(workspace, ".review-artifact"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => ({
        name,
        json: JSON.parse(readFileSync(join(workspace, ".review-artifact", name), "utf8")),
      }));
  } catch {
    return [];
  }
}

/**
 * The SARIF projection the entrypoint wrote into the runner temp — parsed,
 * or `undefined` when the run published none (a terminal's row).
 *
 * @param {string} temp the runner temp the harness handed the run
 * @returns {any | undefined}
 */
export function sarifOf(temp) {
  const name = readdirSync(temp).find((candidate) => candidate.startsWith("review-sarif-"));
  return name === undefined ? undefined : JSON.parse(readFileSync(join(temp, name), "utf8"));
}

/**
 * Drives one scenario through the entrypoint in the named gate mode and
 * returns the run's whole projection. Every case, matrix row and replay
 * schedule in the PR9 suites observes the surfaces through this one
 * function — a surface can only contradict another if it first passes
 * through the same collection here.
 *
 * @param {Scenario} scenario
 * @param {"observe" | "required"} gateMode
 * @returns {Promise<{
 *   settled: { ok: boolean, result: import("./run.mjs").RunResult | undefined, cause: unknown, outFile: string, temp: string },
 *   outcome: import("./run.mjs").RunResult["outcome"] | undefined,
 *   reason: string | undefined,
 *   canonical: import("./canonical.mjs").CanonicalResult | undefined,
 *   gate: import("./merge-gate.mjs").ReviewGateDecision | undefined,
 *   upserts: import("./e2e.fixtures.mjs").RecordingForge["calls"]["upserts"],
 *   deletes: number[],
 *   checkRuns: import("./e2e.fixtures.mjs").RecordingForge["calls"]["checkRuns"],
 *   outputs: string,
 *   sarif: any | undefined,
 *   artifacts: Array<{ name: string, json: any }>,
 * }>}
 */
export async function driveCase(scenario, gateMode) {
  const settled = await driveEntrypoint({
    workspace: scenario.workspace,
    forge: scenario.forge,
    chat: scenario.chat,
    gateMode,
    ...(scenario.extra === undefined ? {} : { extra: scenario.extra }),
  });
  return {
    settled,
    outcome: settled.result?.outcome,
    reason: settled.result?.reason,
    canonical: settled.result?.canonical,
    gate: settled.result?.gate,
    upserts: scenario.forge.calls.upserts,
    deletes: scenario.forge.deletes ?? [],
    checkRuns: scenario.forge.calls.checkRuns,
    outputs: readFileSync(settled.outFile, "utf8"),
    sarif: sarifOf(settled.temp),
    artifacts: artifactsOf(scenario.workspace),
  };
}

/**
 * Rewrites the run-scoped 12-hex marker id to a constant: the one thing a
 * replay may legitimately differ in (the upsert mints a fresh id per run),
 * so replay comparisons cut exactly that and nothing else.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseRunScopedIds(text) {
  return text.replaceAll(/(<!-- action-agents:review:)([0-9a-f]{12})(:head=)/gu, "$1<run-id>$3");
}

/**
 * Reduces the runner outputs' path-valued lines to their basenames: the
 * runner temp directory is created fresh per replay, so the paths differ
 * where the bytes do not.
 *
 * @param {string} outputs
 * @returns {string}
 */
function normaliseOutputPaths(outputs) {
  return outputs
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      if (at <= 0) return line;
      const key = line.slice(0, at);
      return key === "sarif-path" || key === "artifact-file"
        ? `${key}=${line
            .slice(at + 1)
            .split("/")
            .pop()}`
        : line;
    })
    .join("\n");
}

/**
 * The terminal fingerprint of one replay: every surface the run touched,
 * normalised only where a run legitimately varies. Two replays of the same
 * schedule must fingerprint identically — the T18 law that a once-flaky
 * race is reproducible on demand, with no sleeps and no sampling anywhere.
 *
 * @param {Scenario} scenario
 * @param {Awaited<ReturnType<typeof driveCase>>} projection
 * @returns {string}
 */
export function replayFingerprint(scenario, projection) {
  return JSON.stringify({
    ok: projection.settled.ok,
    cause: projection.settled.cause instanceof Error ? projection.settled.cause.message : undefined,
    outcome: projection.outcome,
    reason: projection.reason,
    chatCalls: scenario.chat.calls?.(),
    upserts: projection.upserts.map((upsert) => ({
      ...upsert,
      body: upsert.body === undefined ? undefined : normaliseRunScopedIds(upsert.body),
    })),
    deletes: projection.deletes,
    checkRuns: projection.checkRuns,
    artifacts: projection.artifacts.map((artifact) => [
      artifact.name,
      normaliseRunScopedIds(JSON.stringify(artifact.json)),
    ]),
    outputs: normaliseOutputPaths(projection.outputs),
  });
}
